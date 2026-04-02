/**
 * VDT Data Binding Parser — v2
 *
 * Parses real SAC data binding results where:
 * - Account members are MEASURE COLUMNS (not dimension rows)
 * - @MeasureDimension distinguishes measure types (e.g., Measure1=USD, Measure2=BBL)
 * - Time dimension is hierarchical (Year → Month → Day) with isNode flag
 * - Version dimension contains category implicitly
 * - Unit/currency comes from each measure value
 *
 * Account ID format in mainStructureMembers: "[Account].[parentId].&[1434]"
 * Time ID format: "[Posting_Date].[YMD].[Posting_Date.CALMONTH].[202603]" (month)
 *                 "[Posting_Date].[YMD].&[2026-03-01]" (day)
 */

var VDTDataParser = (function () {

  // ── Regex helpers ──

  /**
   * Extract clean account ID from SAC format.
   * "[Account].[parentId].&[1434]" → "1434"
   */
  function extractAccountId(sacId) {
    if (!sacId) return sacId;
    var match = sacId.match(/\&\[([^\]]+)\]$/);
    return match ? match[1] : sacId;
  }

  /**
   * Extract YYYYMM from a month-level time ID.
   * "[Posting_Date].[YMD].[Posting_Date.CALMONTH].[202603]" → "202603"
   */
  function extractCalMonth(timeId) {
    if (!timeId) return null;
    // Plain 6-digit: "201801"
    if (/^\d{6}$/.test(timeId)) return timeId;
    // Bracketed 6-digit: "[...][202603]" or "[...].&[202603]"
    var match = timeId.match(/\[(\d{6})\]/);
    if (match) return match[1];
    // Anywhere in string: find first 6-digit sequence that looks like YYYYMM
    var anywhere = timeId.match(/(\d{6})/);
    if (anywhere && parseInt(anywhere[1].substring(0, 4)) >= 1900) return anywhere[1];
    return null;
  }

  /**
   * Extract YYYY from a year-level time ID.
   * Handles: "[Time].[YQM].&[2018]", "2018", plain numeric
   */
  function extractYear(timeId) {
    if (!timeId) return null;
    // Plain 4-digit: "2018"
    if (/^\d{4}$/.test(timeId)) return timeId;
    // Bracketed 4-digit: "[...][2018]" or "[...].&[2018]"
    var match = timeId.match(/\[(\d{4})\]/);
    if (match) return match[1];
    // From a 6-digit calMonth: "201801" → "2018"
    if (/^\d{6}$/.test(timeId)) return timeId.substring(0, 4);
    return null;
  }

  /**
   * Check if a time member is a leaf-level node (the lowest expanded level).
   * Leaf members have isNode = false/undefined (not a parent in the hierarchy).
   */
  function isLeafLevel(timeMember) {
    if (!timeMember || !timeMember.id) return false;
    return !timeMember.isNode && !isAllLevel(timeMember);
  }

  /**
   * Check if a time member is a parent/node level (year, quarter, etc.).
   */
  function isNodeLevel(timeMember) {
    if (!timeMember || !timeMember.id) return false;
    return !!timeMember.isNode && !isAllLevel(timeMember);
  }

  /**
   * Check if a time member is the "(all)" aggregation node.
   */
  function isAllLevel(timeMember) {
    if (!timeMember || !timeMember.id) return false;
    return timeMember.id.indexOf("[(all)]") !== -1;
  }

  // Legacy aliases — kept for backward compatibility with getTimeMembers level param
  function isMonthLevel(timeMember) { return isLeafLevel(timeMember); }
  function isYearLevel(timeMember) { return isNodeLevel(timeMember); }

  // ── Metadata parsing ──

  /**
   * Parse the SAC metadata to identify dimension keys, measure keys,
   * and map them to their roles.
   */
  function parseMetadata(metadata, config) {
    var result = {
      dimensionKeys: [],
      measureKeys: [],
      dimensions: {},         // dimKey → {id, description}
      accounts: {},           // measureKey → {sacId, cleanId, label}
      measureDimKey: null,    // key for @MeasureDimension
      versionDimKey: null,    // key for Version dimension
      timeDimKey: null,       // key for Time dimension
      otherDimKeys: []        // keys for other dimensions (Customer, Product, etc.)
    };

    if (!metadata) return result;

    // Dimension keys
    if (metadata.feeds && metadata.feeds.dimensions) {
      result.dimensionKeys = metadata.feeds.dimensions.values || [];
    }
    // Measure keys
    if (metadata.feeds && metadata.feeds.measures) {
      result.measureKeys = metadata.feeds.measures.values || [];
    }

    // Map dimensions
    if (metadata.dimensions) {
      for (var key in metadata.dimensions) {
        var dim = metadata.dimensions[key];
        result.dimensions[key] = dim;

        if (dim.id === "@MeasureDimension") {
          result.measureDimKey = key;
        } else if (config && config.versionDimension && dim.id === config.versionDimension) {
          result.versionDimKey = key;
        } else if (config && config.timeDimension && dim.id === config.timeDimension) {
          result.timeDimKey = key;
        } else if (dim.id === "Version") {
          // Fallback: auto-detect version dimension
          if (!result.versionDimKey) result.versionDimKey = key;
        } else if (dim.id !== "@MeasureDimension") {
          result.otherDimKeys.push(key);
        }
      }
    }

    // Auto-detect time dimension if not configured
    if (!result.timeDimKey) {
      for (var key in result.dimensions) {
        var dimId = result.dimensions[key].id;
        if (dimId.toLowerCase().indexOf("date") !== -1 || dimId.toLowerCase().indexOf("time") !== -1 || dimId.toLowerCase().indexOf("period") !== -1) {
          result.timeDimKey = key;
          // Remove from otherDimKeys
          result.otherDimKeys = result.otherDimKeys.filter(function (k) { return k !== key; });
          break;
        }
      }
    }

    // Map account members from mainStructureMembers
    if (metadata.mainStructureMembers) {
      for (var mKey in metadata.mainStructureMembers) {
        var member = metadata.mainStructureMembers[mKey];
        result.accounts[mKey] = {
          sacId: member.id,
          cleanId: extractAccountId(member.id),
          label: member.label || extractAccountId(member.id),
          parentId: member.parentId ? extractAccountId(member.parentId) : null,
          isNode: !!member.isNode
        };
      }
    }

    return result;
  }

  // ── Data extraction ──

  /**
   * Get the list of account members available in the data binding.
   * Returns [{measureKey, sacId, cleanId, label, parentCleanId, isNode}]
   */
  function getAccountMembers(parsedMeta) {
    var members = [];
    for (var mKey in parsedMeta.accounts) {
      var acct = parsedMeta.accounts[mKey];
      members.push({
        measureKey: mKey,
        sacId: acct.sacId,
        cleanId: acct.cleanId,
        label: acct.label || acct.cleanId,
        parentCleanId: acct.parentId || null,
        isNode: acct.isNode || false
      });
    }
    return members;
  }

  /**
   * Get unique version members from the data.
   * Returns [{id, label}]
   */
  function getVersionMembers(dataBinding, parsedMeta) {
    if (!parsedMeta.versionDimKey || !dataBinding.data) return [];
    var seen = {};
    var members = [];
    var dimKey = parsedMeta.versionDimKey;
    dataBinding.data.forEach(function (row) {
      var m = row[dimKey];
      if (m && !seen[m.id]) {
        seen[m.id] = true;
        members.push({ id: m.id, label: m.label || m.id });
      }
    });
    return members;
  }

  /**
   * Get unique @MeasureDimension members from the data.
   * Returns [{id, label}]
   */
  function getMeasureDimensionMembers(dataBinding, parsedMeta) {
    if (!parsedMeta.measureDimKey || !dataBinding.data) return [];
    var seen = {};
    var members = [];
    var dimKey = parsedMeta.measureDimKey;
    dataBinding.data.forEach(function (row) {
      var m = row[dimKey];
      if (m && !seen[m.id]) {
        seen[m.id] = true;
        members.push({ id: m.id, label: m.label || m.id });
      }
    });
    return members;
  }

  /**
   * Get unique time members at a specific hierarchy level from the data.
   * level: "leaf" (lowest expanded), "node" (parent levels), "all" (aggregate), or null (everything)
   * Legacy aliases: "month" = "leaf", "year" = "node", "day" = "leaf"
   * Returns [{id, label, calMonth, year, parentId, isNode}]
   */
  function getTimeMembers(dataBinding, parsedMeta, level) {
    if (!parsedMeta.timeDimKey || !dataBinding.data) return [];
    var seen = {};
    var members = [];
    var dimKey = parsedMeta.timeDimKey;

    dataBinding.data.forEach(function (row) {
      var m = row[dimKey];
      if (!m || seen[m.id]) return;

      var include = false;
      if ((level === "leaf" || level === "month" || level === "day") && isLeafLevel(m)) include = true;
      else if ((level === "node" || level === "year") && isNodeLevel(m)) include = true;
      else if (level === "all" && isAllLevel(m)) include = true;
      else if (!level) include = true; // all levels

      if (include) {
        seen[m.id] = true;
        members.push({
          id: m.id,
          label: m.label || m.id,
          calMonth: extractCalMonth(m.id),
          year: extractYear(m.parentId) || extractYear(m.id),
          parentId: m.parentId || null,
          isNode: !!m.isNode
        });
      }
    });

    // Sort by extracted date
    members.sort(function (a, b) {
      var aKey = a.calMonth || a.year || a.id;
      var bKey = b.calMonth || b.year || b.id;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });

    return members;
  }

  // ── Value lookup ──

  /**
   * Find the data row matching the given filters.
   *
   * @param {Array} data - dataBinding.data
   * @param {Object} parsedMeta
   * @param {Object} filters - { measureDimValue, versionId, timeId }
   * @returns {Object|null} - the matching data row, or null
   */
  function findRow(data, parsedMeta, filters) {
    if (!data) return null;

    return data.find(function (row) {
      // Filter by @MeasureDimension
      if (filters.measureDimValue && parsedMeta.measureDimKey) {
        var mdVal = row[parsedMeta.measureDimKey];
        if (!mdVal || mdVal.id !== filters.measureDimValue) return false;
      }

      // Filter by Version
      if (filters.versionId && parsedMeta.versionDimKey) {
        var vVal = row[parsedMeta.versionDimKey];
        if (!vVal || vVal.id !== filters.versionId) return false;
      }

      // Filter by Time
      if (filters.timeId && parsedMeta.timeDimKey) {
        var tVal = row[parsedMeta.timeDimKey];
        if (!tVal || tVal.id !== filters.timeId) return false;
      }

      return true;
    }) || null;
  }

  /**
   * Find all data rows matching the given filters.
   */
  function findRows(data, parsedMeta, filters) {
    if (!data) return [];

    return data.filter(function (row) {
      if (filters.measureDimValue && parsedMeta.measureDimKey) {
        var mdVal = row[parsedMeta.measureDimKey];
        if (!mdVal || mdVal.id !== filters.measureDimValue) return false;
      }
      if (filters.versionId && parsedMeta.versionDimKey) {
        var vVal = row[parsedMeta.versionDimKey];
        if (!vVal || vVal.id !== filters.versionId) return false;
      }
      if (filters.timeId && parsedMeta.timeDimKey) {
        var tVal = row[parsedMeta.timeDimKey];
        if (!tVal || tVal.id !== filters.timeId) return false;
      }
      // Filter by time level
      if (filters.timeLevel && parsedMeta.timeDimKey) {
        var tMember = row[parsedMeta.timeDimKey];
        if (filters.timeLevel === "month" && !isMonthLevel(tMember)) return false;
        if (filters.timeLevel === "year" && !isYearLevel(tMember)) return false;
        if (filters.timeLevel === "all" && !isAllLevel(tMember)) return false;
      }
      return true;
    });
  }

  /**
   * Get the value for a specific account from a data row.
   *
   * @param {Object} row - a data row
   * @param {string} measureKey - e.g., "measures_4"
   * @returns {Object|null} - {value, formatted, unit} or null if account has no data in this row
   */
  function getAccountValue(row, measureKey) {
    if (!row || !row[measureKey]) return null;
    var m = row[measureKey];
    return {
      value: m.raw || 0,
      formatted: m.formatted || "",
      unit: m.unit || ""
    };
  }

  /**
   * Get a node's value for a specific version + time combination.
   *
   * @param {Array} data - dataBinding.data
   * @param {Object} parsedMeta
   * @param {string} measureKey - the account's measure key (e.g., "measures_4")
   * @param {string} measureDimValue - @MeasureDimension value (e.g., "Measure1")
   * @param {string} versionId - version member ID
   * @param {string} timeId - time member ID (month level)
   * @returns {Object|null} - {value, formatted, unit}
   */
  function getNodeValue(data, parsedMeta, measureKey, measureDimValue, versionId, timeId) {
    var row = findRow(data, parsedMeta, {
      measureDimValue: measureDimValue,
      versionId: versionId,
      timeId: timeId
    });
    if (!row) return null;
    return getAccountValue(row, measureKey);
  }

  /**
   * Aggregate a node's values across multiple time periods (for YTD, etc.).
   */
  function aggregateNodeValues(data, parsedMeta, measureKey, measureDimValue, versionId, timeIds) {
    var total = 0;
    var unit = "";
    var count = 0;

    timeIds.forEach(function (timeId) {
      var val = getNodeValue(data, parsedMeta, measureKey, measureDimValue, versionId, timeId);
      if (val) {
        total += val.value;
        if (!unit) unit = val.unit;
        count++;
      }
    });

    return count > 0 ? { value: total, unit: unit } : null;
  }

  /**
   * Find the measureKey for a given clean account ID.
   * E.g., "1434" → "measures_4"
   */
  function findMeasureKeyByAccountId(parsedMeta, cleanAccountId) {
    for (var mKey in parsedMeta.accounts) {
      if (parsedMeta.accounts[mKey].cleanId === cleanAccountId) {
        return mKey;
      }
    }
    return null;
  }

  /**
   * Resolve a comparison time period to actual time member IDs.
   * Uses the available month-level time members in the data.
   *
   * @param {string} periodType - e.g., "current_month", "py_month", "ytd", "py_ytd"
   * @param {Array} monthMembers - sorted month-level time members from getTimeMembers()
   * @param {string} currentMonthId - the current month's full SAC time ID
   * @returns {Array} - array of full SAC time member IDs
   */
  function resolveTimePeriod(periodType, monthMembers, currentMonthId) {
    if (!periodType || !monthMembers || monthMembers.length === 0) return [];

    var currentCM = null;
    var currentYear = null;

    // Find current month info
    for (var i = 0; i < monthMembers.length; i++) {
      if (monthMembers[i].id === currentMonthId) {
        currentCM = monthMembers[i].calMonth; // e.g., "202603"
        currentYear = currentCM ? currentCM.substring(0, 4) : null;
        break;
      }
    }
    if (!currentCM) return [currentMonthId]; // fallback

    var currentMonthNum = currentCM.substring(4); // e.g., "03"
    var pyYear = String(parseInt(currentYear) - 1);

    switch (periodType) {
      case "current_month":
        return [currentMonthId];

      case "py_month":
        return findMonthIds(monthMembers, pyYear + currentMonthNum);

      case "ytd":
        return findYTDIds(monthMembers, currentYear, parseInt(currentMonthNum));

      case "py_ytd":
        return findYTDIds(monthMembers, pyYear, parseInt(currentMonthNum));

      case "current_quarter":
        return findQuarterIds(monthMembers, currentYear, parseInt(currentMonthNum));

      case "py_quarter":
        return findQuarterIds(monthMembers, pyYear, parseInt(currentMonthNum));

      case "current_year":
        return findYearIds(monthMembers, currentYear);

      case "py_year":
        return findYearIds(monthMembers, pyYear);

      case "qtd":
        return findQTDIds(monthMembers, currentYear, parseInt(currentMonthNum));

      case "py_qtd":
        return findQTDIds(monthMembers, pyYear, parseInt(currentMonthNum));

      case "mtd":
      case "py_mtd":
        var targetYear = periodType === "py_mtd" ? pyYear : currentYear;
        return findMonthIds(monthMembers, targetYear + currentMonthNum);

      default:
        return [];
    }
  }

  function findMonthIds(monthMembers, calMonth) {
    return monthMembers
      .filter(function (m) { return m.calMonth === calMonth; })
      .map(function (m) { return m.id; });
  }

  function findYTDIds(monthMembers, year, throughMonth) {
    return monthMembers
      .filter(function (m) {
        if (!m.calMonth || m.calMonth.substring(0, 4) !== year) return false;
        var month = parseInt(m.calMonth.substring(4));
        return month >= 1 && month <= throughMonth;
      })
      .map(function (m) { return m.id; });
  }

  function findQuarterIds(monthMembers, year, monthInQuarter) {
    var qStart = Math.floor((monthInQuarter - 1) / 3) * 3 + 1;
    return monthMembers
      .filter(function (m) {
        if (!m.calMonth || m.calMonth.substring(0, 4) !== year) return false;
        var month = parseInt(m.calMonth.substring(4));
        return month >= qStart && month <= qStart + 2;
      })
      .map(function (m) { return m.id; });
  }

  function findYearIds(monthMembers, year) {
    return monthMembers
      .filter(function (m) { return m.calMonth && m.calMonth.substring(0, 4) === year; })
      .map(function (m) { return m.id; });
  }

  function findQTDIds(monthMembers, year, currentMonth) {
    var qStart = Math.floor((currentMonth - 1) / 3) * 3 + 1;
    return monthMembers
      .filter(function (m) {
        if (!m.calMonth || m.calMonth.substring(0, 4) !== year) return false;
        var month = parseInt(m.calMonth.substring(4));
        return month >= qStart && month <= currentMonth;
      })
      .map(function (m) { return m.id; });
  }

  // ── Public API ──
  return {
    // Helpers
    extractAccountId: extractAccountId,
    extractCalMonth: extractCalMonth,
    isMonthLevel: isMonthLevel,
    isYearLevel: isYearLevel,
    isAllLevel: isAllLevel,

    // Metadata
    parseMetadata: parseMetadata,

    // Members
    getAccountMembers: getAccountMembers,
    getVersionMembers: getVersionMembers,
    getMeasureDimensionMembers: getMeasureDimensionMembers,
    getTimeMembers: getTimeMembers,

    // Value lookup
    findRow: findRow,
    findRows: findRows,
    getAccountValue: getAccountValue,
    getNodeValue: getNodeValue,
    aggregateNodeValues: aggregateNodeValues,
    findMeasureKeyByAccountId: findMeasureKeyByAccountId,

    // Time resolution
    resolveTimePeriod: resolveTimePeriod
  };

})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = VDTDataParser;
}

(function () {
  // ── Constants ──
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // ── CSS (embedded in shadow DOM) ──
  const STYLES = `
    @font-face { font-family: "72"; src: url("https://openui5.hana.ondemand.com/resources/sap/ui/core/themes/sap_fiori_3/fonts/72-Regular-full.woff2") format("woff2"); font-weight: 400; }
    @font-face { font-family: "72"; src: url("https://openui5.hana.ondemand.com/resources/sap/ui/core/themes/sap_fiori_3/fonts/72-Bold-full.woff2") format("woff2"); font-weight: 600; }
    @font-face { font-family: "72"; src: url("https://openui5.hana.ondemand.com/resources/sap/ui/core/themes/sap_fiori_3/fonts/72-Bold-full.woff2") format("woff2"); font-weight: 700; }
    @font-face { font-family: "72"; src: url("https://openui5.hana.ondemand.com/resources/sap/ui/core/themes/sap_fiori_3/fonts/72-Light-full.woff2") format("woff2"); font-weight: 300; }

    :host { font-family: "72", Arial, Helvetica, sans-serif; box-sizing: border-box; display: block; width: 100%; height: 100%; }
    *, *::before, *::after { box-sizing: inherit; }

    .vdt-root { width: 100%; height: 100%; overflow: hidden; background: #f5f6f7; position: relative; font-family: "72", Arial, Helvetica, sans-serif; }
    .vdt-viewport { width: 100%; height: 100%; overflow: auto; padding: 16px; }
    .vdt-zoom-wrapper { transform-origin: 0 0; }
    .vdt-tree-root { position: relative; display: inline-block; min-width: 100%; }
    .vdt-connectors-svg { position: absolute; top: 0; left: 0; pointer-events: none; overflow: visible; }

    /* Zoom toolbar */
    .vdt-zoom-bar {
      position: absolute; bottom: 12px; left: 12px; z-index: 90;
      display: flex; align-items: center; gap: 2px;
      background: #fff; border: 1px solid #d9d9d9; border-radius: 6px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.12); padding: 2px 4px;
    }
    .vdt-zoom-btn {
      width: 28px; height: 28px; border: none; background: transparent; border-radius: 4px;
      cursor: pointer; font-size: 16px; font-weight: 600; color: #32363a; display: flex;
      align-items: center; justify-content: center; font-family: "72", Arial, sans-serif;
    }
    .vdt-zoom-btn:hover { background: #e8e8e8; }
    .vdt-zoom-label {
      font-size: 11px; font-weight: 600; color: #6a6d70; min-width: 40px;
      text-align: center; user-select: none; cursor: pointer;
    }
    .vdt-zoom-label:hover { color: #0a6ed1; }
    .vdt-zoom-sep { width: 1px; height: 20px; background: #d9d9d9; margin: 0 2px; }

    /* Minimap */
    .vdt-minimap {
      position: absolute; bottom: 12px; right: 12px; z-index: 90;
      width: 180px; height: 120px; background: #fff; border: 1px solid #d9d9d9;
      border-radius: 6px; box-shadow: 0 1px 4px rgba(0,0,0,0.12); overflow: hidden;
      cursor: pointer;
    }
    .vdt-minimap--hidden { display: none; }
    .vdt-minimap__canvas { width: 100%; height: 100%; }
    .vdt-minimap__viewport {
      position: absolute; border: 2px solid #0a6ed1; background: rgba(10,110,209,0.08);
      border-radius: 2px; pointer-events: none;
    }
    .vdt-minimap-toggle {
      position: absolute; bottom: 12px; right: 12px; z-index: 89;
      width: 28px; height: 28px; border: 1px solid #d9d9d9; background: #fff;
      border-radius: 6px; box-shadow: 0 1px 4px rgba(0,0,0,0.12); cursor: pointer;
      display: flex; align-items: center; justify-content: center; font-size: 14px; color: #6a6d70;
    }
    .vdt-minimap-toggle:hover { background: #e8e8e8; }
    .vdt-minimap-toggle--active { display: none; }

    .vdt-level { display: flex; align-items: center; position: relative; }
    .vdt-level__gap { width: 48px; flex-shrink: 0; }
    .vdt-level__children { display: flex; flex-direction: column; gap: 16px; }

    .vdt-node-wrap { position: relative; }
    .vdt-node { display: grid; grid-template-columns: 6px 1fr 1fr; grid-template-rows: auto 1fr auto; width: 400px; min-height: 140px; border: 1px solid #d9d9d9; border-radius: 8px; overflow: hidden; background: #ffffff; box-shadow: 0 1px 4px rgba(0,0,0,0.08); transition: box-shadow 0.2s ease; font-family: "72", Arial, Helvetica, sans-serif; }
    .vdt-node:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.14); }

    /* Threshold bar */
    .vdt-node__threshold { grid-column: 1; grid-row: 1 / -1; border-radius: 8px 0 0 8px; display: flex; align-items: center; justify-content: center; min-width: 6px; }
    .vdt-node__threshold--positive { background: #107e3e; }
    .vdt-node__threshold--warning { background: #e9730c; }
    .vdt-node__threshold--negative { background: #bb0000; }
    .vdt-node__threshold--neutral { background: #89919a; }
    .vdt-node__threshold-arrow { color: #fff; font-size: 8px; line-height: 1; }

    /* Header */
    .vdt-node__header { grid-column: 2 / 4; display: flex; justify-content: space-between; align-items: baseline; padding: 12px 14px 8px 14px; border-bottom: 1px solid #eee; gap: 8px; }
    .vdt-node__measure-name { font-size: 13px; font-weight: 600; color: #32363a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .vdt-node__impact { font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 3px; white-space: nowrap; flex-shrink: 0; }
    .vdt-node__impact--positive { color: #107e3e; background: rgba(16,126,62,0.08); }
    .vdt-node__impact--negative { color: #bb0000; background: rgba(187,0,0,0.08); }
    .vdt-node__measure-value { text-align: right; white-space: nowrap; }
    .vdt-node__value { font-size: 18px; font-weight: 700; color: #32363a; letter-spacing: -0.3px; }
    .vdt-node__unit { font-size: 11px; font-weight: 400; color: #6a6d70; margin-left: 4px; }

    /* Body */
    .vdt-node__body { grid-column: 2 / 4; display: grid; grid-template-columns: 1fr 1fr; padding: 10px 14px 12px 14px; gap: 8px; }

    /* Sparkline */
    .vdt-node__microchart { display: flex; align-items: flex-end; }
    .vdt-node__microchart svg { width: 100%; height: 48px; }
    .sparkline { fill: none; stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round; }
    .sparkline--positive { stroke: #107e3e; }
    .sparkline--negative { stroke: #bb0000; }
    .sparkline--neutral { stroke: #89919a; }
    .sparkline-area { opacity: 0.08; }
    .sparkline-area--positive { fill: #107e3e; }
    .sparkline-area--negative { fill: #bb0000; }
    .sparkline-area--neutral { fill: #89919a; }

    /* Display Rows */
    .vdt-node__display-rows { display: flex; flex-direction: column; justify-content: center; gap: 2px; }
    .vdt-node__value-row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 6px; padding: 2px 0; }
    .vdt-node__value-row + .vdt-node__value-row { border-top: 1px solid #f0f0f0; }
    .vdt-node__row-label { font-size: 10px; font-weight: 600; color: #6a6d70; text-transform: uppercase; letter-spacing: 0.3px; white-space: nowrap; }
    .vdt-node__row-value { font-size: 12px; font-weight: 600; color: #32363a; white-space: nowrap; text-align: right; }
    .vdt-node__row-variance { text-align: right; white-space: nowrap; }

    /* Comparison (legacy) */
    .vdt-node__comparison { display: flex; flex-direction: column; justify-content: center; gap: 2px; }
    .vdt-node__comp-group { display: flex; flex-direction: column; gap: 1px; }
    .vdt-node__comp-group + .vdt-node__comp-group { margin-top: 6px; padding-top: 6px; border-top: 1px solid #eee; }
    .vdt-node__comp-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .vdt-node__comp-label { font-size: 10px; font-weight: 600; color: #6a6d70; text-transform: uppercase; letter-spacing: 0.3px; text-align: left; white-space: nowrap; }
    .vdt-node__comp-value { font-size: 12px; font-weight: 600; color: #32363a; text-align: right; white-space: nowrap; }
    .vdt-node__variance { display: flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; text-align: right; white-space: nowrap; margin-left: auto; }
    .vdt-node__variance--positive { color: #107e3e; }
    .vdt-node__variance--negative { color: #bb0000; }
    .vdt-node__variance--neutral { color: #6a6d70; }
    .vdt-node__variance-arrow { font-size: 9px; }

    /* Anchor */
    .vdt-node__anchor { position: absolute; right: -11px; top: 50%; transform: translateY(-50%); width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; z-index: 2; border: none; background: #0a6ed1; color: #fff; }
    .vdt-node__anchor--data svg { width: 11px; height: 11px; fill: #fff; }

    /* Expand/Collapse */
    .vdt-node__toggle { position: absolute; right: -16px; top: calc(50% + 18px); width: 24px; height: 24px; border-radius: 50%; border: 2px solid #d9d9d9; background: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 12px; color: #6a6d70; z-index: 2; transition: background 0.15s ease, border-color 0.15s ease; }
    .vdt-node__toggle:hover { background: #f5f6f7; border-color: #89919a; color: #32363a; }
    .vdt-node__toggle--collapsed::after { content: "+"; font-weight: 700; }
    .vdt-node__toggle--expanded::after { content: "\\2212"; font-weight: 700; }

    /* Slider input */
    .vdt-node__input { grid-column: 2 / 4; padding: 6px 14px 10px 14px; border-top: 1px solid #eee; display: flex; align-items: center; gap: 10px; }
    .vdt-node__slider-wrap { flex: 1; display: flex; align-items: center; gap: 8px; }
    .vdt-node__slider { -webkit-appearance: none; appearance: none; flex: 1; height: 6px; border-radius: 3px; background: #e8e8e8; outline: none; position: relative; z-index: 3; touch-action: none; }
    .vdt-node__slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #0a6ed1; cursor: pointer; border: 2px solid #fff; box-shadow: 0 0 0 1px #0a6ed1; }
    .vdt-node__slider-pct { font-size: 11px; font-weight: 600; color: #32363a; min-width: 42px; text-align: right; white-space: nowrap; }
    .vdt-node__slider-pct--positive { color: #107e3e; }
    .vdt-node__slider-pct--negative { color: #bb0000; }
    .vdt-node__detail-btn { width: 24px; height: 24px; border-radius: 4px; border: 1px solid #d9d9d9; background: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; color: #6a6d70; font-size: 12px; flex-shrink: 0; }
    .vdt-node__detail-btn:hover { background: #f5f6f7; border-color: #89919a; color: #32363a; }
    .vdt-node__detail-btn svg { width: 14px; height: 14px; fill: currentColor; }

    /* Detail panel */
    .vdt-node__detail-panel { display: none; position: absolute; top: 0; left: calc(100% + 8px); z-index: 10; background: #fff; border: 1px solid #d9d9d9; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.12); padding: 10px 14px 12px 14px; min-width: 220px; font-family: "72", Arial, Helvetica, sans-serif; }
    .vdt-node__detail-panel--open { display: block; }
    .vdt-node__detail-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid #eee; }
    .vdt-node__detail-title { font-size: 11px; font-weight: 600; color: #6a6d70; text-transform: uppercase; letter-spacing: 0.3px; }
    .vdt-node__detail-total { font-size: 11px; font-weight: 600; color: #32363a; }
    .vdt-node__detail-table { width: 100%; border-collapse: collapse; }
    .vdt-node__detail-table th { font-size: 9px; font-weight: 600; color: #89919a; text-transform: uppercase; text-align: left; padding: 3px 6px; border-bottom: 1px solid #eee; }
    .vdt-node__detail-table th:nth-child(2), .vdt-node__detail-table th:nth-child(3) { text-align: right; }
    .vdt-node__detail-table td { padding: 3px 6px; border-bottom: 1px solid #f5f5f5; }
    .vdt-node__detail-month-label { font-size: 10px; font-weight: 600; color: #32363a; }
    .vdt-node__detail-month-input { width: 80px; font-family: "72", Arial, Helvetica, sans-serif; font-size: 10px; font-weight: 600; color: #32363a; text-align: right; padding: 2px 6px; background: #fff; border: 1px solid #d9d9d9; border-radius: 3px; outline: none; }
    .vdt-node__detail-month-input:focus { border-color: #0a6ed1; box-shadow: 0 0 0 2px rgba(10,110,209,0.15); }
    .vdt-node__detail-month-delta { font-size: 9px; font-weight: 600; text-align: right; white-space: nowrap; }
    .vdt-node__detail-month-delta--positive { color: #107e3e; }
    .vdt-node__detail-month-delta--negative { color: #bb0000; }
    .vdt-node__detail-month-delta--neutral { color: #89919a; }

    /* Empty state */
    .vdt-empty { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; color: #6a6d70; font-size: 14px; }

    /* On-canvas design mode controls */
    .vdt-design-add-child {
      display: none; position: absolute; right: -40px; top: 50%; transform: translateY(-50%);
      width: 26px; height: 26px; border-radius: 50%; border: 2px dashed #0a6ed1;
      background: #fff; color: #0a6ed1; font-size: 16px; font-weight: 700;
      cursor: pointer; z-index: 5; align-items: center; justify-content: center;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .vdt-design-add-child:hover { background: #e3f2fd; border-style: solid; }
    .vdt-design-mode .vdt-design-add-child { display: flex; }
    .vdt-design-mode .vdt-node__toggle { right: -46px; }
    .vdt-design-mode .vdt-node__anchor { right: -11px; }

    .vdt-design-edit {
      display: none; position: absolute; top: -4px; right: -4px; z-index: 6;
      width: 20px; height: 20px; border-radius: 50%; border: 1px solid #d9d9d9;
      background: #fff; cursor: pointer; font-size: 10px; color: #6a6d70;
      align-items: center; justify-content: center;
    }
    .vdt-design-edit:hover { background: #f0f7ff; color: #0a6ed1; border-color: #0a6ed1; }
    .vdt-design-mode .vdt-design-edit { display: flex; }

    .vdt-design-del {
      display: none; position: absolute; top: -4px; right: 18px; z-index: 6;
      width: 20px; height: 20px; border-radius: 50%; border: 1px solid #d9d9d9;
      background: #fff; cursor: pointer; font-size: 12px; color: #6a6d70;
      align-items: center; justify-content: center;
    }
    .vdt-design-del:hover { background: #fce4ec; color: #bb0000; border-color: #bb0000; }
    .vdt-design-mode .vdt-design-del { display: flex; }

    /* Inline edit popup on canvas */
    .vdt-design-popup {
      display: none; position: absolute; top: -8px; left: calc(100% + 12px); z-index: 20;
      background: #fff; border: 1px solid #0a6ed1; border-radius: 6px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.15); padding: 10px 12px;
      min-width: 240px; font-family: "72", Arial, Helvetica, sans-serif;
    }
    .vdt-design-popup--open { display: block; }
    .vdt-design-popup__title {
      font-size: 10px; font-weight: 700; color: #0a6ed1; text-transform: uppercase;
      letter-spacing: 0.3px; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid #eee;
    }
    .vdt-design-popup .vdt-config-field { margin-bottom: 6px; }
    .vdt-design-popup .vdt-config-field label {
      display: block; font-size: 9px; font-weight: 600; color: #6a6d70; margin-bottom: 2px;
    }
    .vdt-design-popup .vdt-config-field select,
    .vdt-design-popup .vdt-config-field input {
      width: 100%; font-family: "72", Arial, sans-serif; font-size: 10px;
      padding: 4px 6px; border: 1px solid #d9d9d9; border-radius: 3px;
      outline: none; background: #fff; color: #32363a; box-sizing: border-box;
    }
    .vdt-design-popup .vdt-config-field select:focus,
    .vdt-design-popup .vdt-config-field input:focus { border-color: #0a6ed1; }
    .vdt-design-popup__actions { display: flex; gap: 4px; margin-top: 8px; }
    .vdt-design-popup__btn {
      font-family: "72", Arial, sans-serif; font-size: 10px; font-weight: 600;
      padding: 4px 10px; border: none; border-radius: 3px; cursor: pointer;
    }
    .vdt-design-popup__btn--ok { background: #0a6ed1; color: #fff; }
    .vdt-design-popup__btn--ok:hover { background: #085cad; }
    .vdt-design-popup__btn--cancel { background: #fff; color: #6a6d70; border: 1px solid #d9d9d9; }
  `;

  // ── Design-mode config panel styles ──
  const CONFIG_STYLES = `
    .vdt-config-overlay {
      display: none; position: absolute; top: 0; right: 0; width: 320px; height: 100%;
      background: #fff; border-left: 2px solid #0a6ed1; z-index: 100; overflow-y: auto;
      box-shadow: -2px 0 8px rgba(0,0,0,0.1); font-family: "72", Arial, Helvetica, sans-serif;
    }
    .vdt-config-overlay--open { display: block; }
    .vdt-config-header {
      font-size: 13px; font-weight: 700; color: #fff; background: #0a6ed1;
      padding: 10px 14px; display: flex; justify-content: space-between; align-items: center;
    }
    .vdt-config-close {
      background: none; border: none; color: #fff; font-size: 18px; cursor: pointer;
      padding: 0 4px; line-height: 1;
    }
    .vdt-config-body { padding: 12px 14px; }
    .vdt-config-section { margin-bottom: 16px; }
    .vdt-config-section-title {
      font-size: 10px; font-weight: 700; color: #6a6d70; text-transform: uppercase;
      letter-spacing: 0.4px; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid #eee;
    }
    .vdt-config-field { margin-bottom: 8px; }
    .vdt-config-field label {
      display: block; font-size: 10px; font-weight: 600; color: #6a6d70; margin-bottom: 3px;
    }
    .vdt-config-field select, .vdt-config-field input, .vdt-config-field textarea {
      width: 100%; font-family: "72", Arial, sans-serif; font-size: 11px;
      padding: 5px 7px; border: 1px solid #d9d9d9; border-radius: 4px; outline: none;
      background: #fff; color: #32363a; box-sizing: border-box;
    }
    .vdt-config-field select:focus, .vdt-config-field input:focus, .vdt-config-field textarea:focus {
      border-color: #0a6ed1; box-shadow: 0 0 0 2px rgba(10,110,209,0.15);
    }
    .vdt-config-field textarea { min-height: 60px; resize: vertical; font-size: 10px; }
    .vdt-config-hint { font-size: 9px; color: #89919a; margin-top: 2px; line-height: 1.3; }
    .vdt-config-status {
      font-size: 10px; padding: 4px 8px; border-radius: 3px; margin-top: 4px;
    }
    .vdt-config-status--ok { background: #e8f5e9; color: #107e3e; }
    .vdt-config-status--warn { background: #fff3e0; color: #e9730c; }
    .vdt-config-btn {
      font-family: "72", Arial, sans-serif; font-size: 11px; font-weight: 600;
      padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer;
    }
    .vdt-config-btn--primary { background: #0a6ed1; color: #fff; }
    .vdt-config-btn--primary:hover { background: #085cad; }
    .vdt-config-btn--secondary { background: #fff; color: #32363a; border: 1px solid #d9d9d9; }
    .vdt-config-btn--secondary:hover { background: #f5f6f7; }
    .vdt-config-actions { display: flex; gap: 6px; margin-top: 12px; }
    .vdt-config-toggle {
      position: absolute; top: 8px; right: 8px; z-index: 50;
      width: 28px; height: 28px; border-radius: 4px; border: 1px solid #d9d9d9;
      background: #fff; display: none; align-items: center; justify-content: center;
      cursor: pointer; color: #0a6ed1; font-size: 14px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .vdt-config-toggle:hover { background: #f0f7ff; border-color: #0a6ed1; }
    .vdt-config-toggle--visible { display: flex; }

    /* Tree builder */
    .vdt-config-node-list { margin-top: 8px; }
    .vdt-config-node-item {
      display: flex; align-items: center; gap: 6px; padding: 5px 8px;
      border: 1px solid #eee; border-radius: 4px; margin-bottom: 4px; font-size: 10px;
      background: #fafafa;
    }
    .vdt-config-node-item__name { flex: 1; font-weight: 600; color: #32363a; }
    .vdt-config-node-item__account { font-size: 9px; color: #6a6d70; }
    .vdt-config-node-item__remove {
      background: none; border: none; color: #bb0000; cursor: pointer; font-size: 12px;
      padding: 0 2px;
    }

    /* Tree builder specific */
    .vdt-builder-tree { margin-top: 8px; }
    .vdt-builder-node {
      border: 1px solid #d9d9d9; border-radius: 4px; margin-bottom: 6px;
      background: #fff; font-size: 10px;
    }
    .vdt-builder-node--calc { border-left: 3px solid #0a6ed1; }
    .vdt-builder-node--data { border-left: 3px solid #107e3e; }
    .vdt-builder-node__header {
      display: flex; align-items: center; gap: 6px; padding: 6px 8px;
      cursor: pointer; user-select: none;
    }
    .vdt-builder-node__header:hover { background: #f5f6f7; }
    .vdt-builder-node__icon {
      width: 18px; height: 18px; border-radius: 50%; display: flex;
      align-items: center; justify-content: center; font-size: 10px;
      font-weight: 700; color: #fff; flex-shrink: 0;
    }
    .vdt-builder-node__icon--calc { background: #0a6ed1; }
    .vdt-builder-node__icon--data { background: #107e3e; }
    .vdt-builder-node__label { flex: 1; font-weight: 600; color: #32363a; }
    .vdt-builder-node__badge { font-size: 9px; color: #6a6d70; }
    .vdt-builder-node__actions { display: flex; gap: 2px; }
    .vdt-builder-node__btn {
      background: none; border: none; cursor: pointer; font-size: 11px;
      color: #6a6d70; padding: 2px 4px; border-radius: 3px;
    }
    .vdt-builder-node__btn:hover { background: #eee; color: #32363a; }
    .vdt-builder-node__btn--del:hover { color: #bb0000; }
    .vdt-builder-node__children {
      padding: 0 0 4px 20px;
    }

    /* Add node form */
    .vdt-builder-add {
      display: flex; gap: 4px; margin-top: 6px; align-items: center;
    }
    .vdt-builder-add select, .vdt-builder-add input {
      font-family: "72", Arial, sans-serif; font-size: 10px;
      padding: 4px 6px; border: 1px solid #d9d9d9; border-radius: 3px;
      outline: none; background: #fff; color: #32363a;
    }
    .vdt-builder-add select:focus, .vdt-builder-add input:focus {
      border-color: #0a6ed1;
    }
    .vdt-builder-add__name { flex: 1; min-width: 60px; }
    .vdt-builder-add__acct { width: 80px; }
    .vdt-builder-add__btn {
      font-family: "72", Arial, sans-serif; font-size: 10px; font-weight: 600;
      padding: 4px 8px; border: none; border-radius: 3px; cursor: pointer;
      background: #0a6ed1; color: #fff; white-space: nowrap;
    }
    .vdt-builder-add__btn:hover { background: #085cad; }
    .vdt-builder-add__btn--calc { background: #0a6ed1; }
    .vdt-builder-add__btn--data { background: #107e3e; }
    .vdt-builder-add__btn--data:hover { background: #0b6b32; }

    /* Edit inline */
    .vdt-builder-edit {
      padding: 6px 8px 8px 28px; border-top: 1px solid #eee;
      display: none; flex-direction: column; gap: 4px;
    }
    .vdt-builder-edit--open { display: flex; }
    .vdt-builder-edit .vdt-config-field { margin-bottom: 4px; }
    .vdt-builder-edit label { font-size: 9px; }
    .vdt-builder-edit select, .vdt-builder-edit input {
      font-size: 10px; padding: 3px 6px;
    }

    .vdt-builder-op-select {
      font-family: "72", Arial, sans-serif; font-size: 11px;
      padding: 2px 6px; border: 1px solid #d9d9d9; border-radius: 3px;
      background: #fff; min-width: 36px;
    }
  `;

  // ── Design-mode config panel HTML ──
  const CONFIG_HTML = `
    <button class="vdt-config-toggle" id="configToggle" title="Configure widget">&#9881;</button>
    <div class="vdt-config-overlay" id="configOverlay">
      <div class="vdt-config-header">
        <span>Widget Configuration</span>
        <button class="vdt-config-close" id="configClose">&times;</button>
      </div>
      <div class="vdt-config-body">

        <div class="vdt-config-section">
          <div class="vdt-config-section-title">Data Binding</div>
          <div class="vdt-config-field">
            <label>Version Dimension</label>
            <select id="cfgVersionDim"><option value="">(auto-detect)</option></select>
          </div>
          <div class="vdt-config-field">
            <label>Measure</label>
            <select id="cfgMeasure"><option value="">(auto-detect)</option></select>
            <div class="vdt-config-hint">@MeasureDimension value (e.g., Revenue USD vs Volume BBL).</div>
          </div>
          <div class="vdt-config-field">
            <label>Time Dimension</label>
            <select id="cfgTimeDim"><option value="">(auto-detect)</option></select>
          </div>
          <div class="vdt-config-field">
            <label>Time Granularity</label>
            <select id="cfgTimeGranularity">
              <option value="month">Month</option>
              <option value="quarter">Quarter</option>
              <option value="year">Year</option>
            </select>
            <div class="vdt-config-hint">Must match the expansion level in the data binding.</div>
          </div>
          <div id="cfgDimStatus"></div>
        </div>

        <div class="vdt-config-section">
          <div class="vdt-config-section-title">Data Set 1 (Primary / Editable)</div>
          <div class="vdt-config-field">
            <label>Version</label>
            <select id="cfgDs1Version"><option value="">(first available)</option></select>
          </div>
          <div class="vdt-config-field">
            <label>Year</label>
            <select id="cfgDs1Year"><option value="">(all available)</option></select>
          </div>
        </div>

        <div class="vdt-config-section">
          <div class="vdt-config-section-title">Data Set 2 (Comparison / Read-Only)</div>
          <div class="vdt-config-field">
            <label>Version</label>
            <select id="cfgDs2Version"><option value="">(none)</option></select>
          </div>
          <div class="vdt-config-field">
            <label>Year</label>
            <select id="cfgDs2Year"><option value="">(none)</option></select>
          </div>
        </div>

        <div class="vdt-config-section">
          <div class="vdt-config-section-title">Display Settings</div>
          <div class="vdt-config-field">
            <label>Default Month</label>
            <select id="cfgDefaultMonth">
              <option value="current">Current Month</option>
              <option value="01">January</option><option value="02">February</option>
              <option value="03">March</option><option value="04">April</option>
              <option value="05">May</option><option value="06">June</option>
              <option value="07">July</option><option value="08">August</option>
              <option value="09">September</option><option value="10">October</option>
              <option value="11">November</option><option value="12">December</option>
            </select>
          </div>
          <div class="vdt-config-field">
            <label>Value Rows (up to 4)</label>
            <div id="cfgValueRows"></div>
            <button class="vdt-config-btn vdt-config-btn--secondary" id="cfgAddValueRow" style="margin-top:4px;">+ Add Row</button>
          </div>
        </div>

        <div class="vdt-config-section">
          <div class="vdt-config-section-title">Tree Builder</div>
          <div class="vdt-config-hint" style="margin-bottom:6px;">Build your value driver tree. Add calculated nodes (blue) to group accounts, and data nodes (green) bound to accounts.</div>

          <div class="vdt-builder-tree" id="builderTree">
            <div class="vdt-config-hint">(empty — add a root node below)</div>
          </div>

          <div style="margin-top:8px;">
            <div class="vdt-config-hint" style="margin-bottom:4px; font-weight:600; color:#32363a;">Add Node</div>
            <div class="vdt-builder-add">
              <input type="text" class="vdt-builder-add__name" id="builderNewName" placeholder="Node name" />
              <select id="builderNewAccount">
                <option value="">(calculated)</option>
              </select>
              <select id="builderNewOp" style="width:40px;">
                <option value="+">+</option>
                <option value="−">−</option>
                <option value="×">×</option>
                <option value="÷">÷</option>
              </select>
              <button class="vdt-builder-add__btn" id="builderAddBtn">Add</button>
            </div>
            <div class="vdt-config-hint" style="margin-top:3px;">Select an account to create a data node, or leave as "(calculated)" for a grouping node. Operator applies to calculated nodes.</div>
          </div>

          <div class="vdt-config-actions" style="margin-top:12px;">
            <button class="vdt-config-btn vdt-config-btn--primary" id="cfgApply">Apply Tree</button>
            <button class="vdt-config-btn vdt-config-btn--secondary" id="cfgLoadDemo">Load Demo</button>
          </div>
          <div id="cfgApplyStatus"></div>
        </div>

      </div>
    </div>
  `;

  // ── Template ──
  const template = document.createElement("template");
  template.innerHTML = `
    <style>${STYLES}${CONFIG_STYLES}</style>
    <div class="vdt-root">
      <div class="vdt-empty" id="emptyState">Assign a data source and configure the tree structure to get started.</div>
      <div class="vdt-viewport" id="viewport">
        <div class="vdt-zoom-wrapper" id="zoomWrapper">
          <div class="vdt-tree-root" id="treeRoot" style="display:none;">
            <svg class="vdt-connectors-svg" id="connectorsSvg"></svg>
            <div id="treeContainer"></div>
          </div>
        </div>
      </div>
      <div class="vdt-zoom-bar" id="zoomBar" style="display:none;">
        <button class="vdt-zoom-btn" id="zoomOut" title="Zoom out">&#8722;</button>
        <span class="vdt-zoom-label" id="zoomLabel" title="Reset zoom">100%</span>
        <button class="vdt-zoom-btn" id="zoomIn" title="Zoom in">+</button>
        <div class="vdt-zoom-sep"></div>
        <button class="vdt-zoom-btn" id="zoomFit" title="Fit to view">&#9632;</button>
        <div class="vdt-zoom-sep"></div>
        <button class="vdt-zoom-btn" id="minimapToggle" title="Toggle minimap">&#9635;</button>
      </div>
      <div class="vdt-minimap" id="minimap">
        <canvas class="vdt-minimap__canvas" id="minimapCanvas"></canvas>
        <div class="vdt-minimap__viewport" id="minimapViewport"></div>
      </div>
      ${CONFIG_HTML}
    </div>
  `;

  // ── VDT Engine (tree logic) ──
  class VDTEngine {
    constructor() {
      this.treeData = null;
      this.nodeIndex = {};
      this._planningContext = null;
    }

    // Build tree from configuration + data binding result
    buildTree(config, dataBinding, widgetProps) {
      if (!config || !config.nodes || config.nodes.length === 0) return null;
      if (!dataBinding || !dataBinding.data || !dataBinding.metadata) return null;

      // Parse SAC data binding using VDTDataParser
      const parserConfig = {
        versionDimension: widgetProps.versionDimension || "Version",
        timeDimension: widgetProps.timeDimension || ""
      };
      const parsedMeta = VDTDataParser.parseMetadata(dataBinding.metadata, parserConfig);
      const monthMembers = VDTDataParser.getTimeMembers(dataBinding, parsedMeta, "month");
      const yearMembers = VDTDataParser.getTimeMembers(dataBinding, parsedMeta, "year");

      // Resolve Data Set versions (backward compat: fall back to activeVersion)
      const ds1Version = widgetProps.ds1Version || widgetProps.activeVersion || "public.Actual";
      const ds2Version = widgetProps.ds2Version || "";
      const ds1Year = widgetProps.ds1Year || "";
      const ds2Year = widgetProps.ds2Year || "";

      // Filter month members by year for each data set
      const ds1Months = ds1Year ? monthMembers.filter(m => m.calMonth && m.calMonth.substring(0, 4) === ds1Year) : monthMembers;
      const ds2Months = ds2Year ? monthMembers.filter(m => m.calMonth && m.calMonth.substring(0, 4) === ds2Year) : monthMembers;

      // Resolve default month index (0-based)
      const defaultMonth = widgetProps.defaultMonth || "current";
      let defaultMonthIdx;
      if (defaultMonth === "current") {
        defaultMonthIdx = new Date().getMonth();
      } else {
        defaultMonthIdx = parseInt(defaultMonth) - 1;
      }
      this._defaultMonthIdx = defaultMonthIdx;

      // Parse value rows config
      let valueRowsConfig;
      try {
        valueRowsConfig = JSON.parse(widgetProps.valueRows || "[]");
      } catch (e) { valueRowsConfig = []; }
      if (valueRowsConfig.length === 0) {
        valueRowsConfig = [
          { dataSet: 1, timeVariant: "fullYear", label: "DS1 Full Year" },
          { dataSet: 2, timeVariant: "fullYear", label: "DS2 Full Year" }
        ];
      }
      this._valueRowsConfig = valueRowsConfig;

      const measureDimValue = widgetProps.measureDimValue || null;

      // Auto-detect @MeasureDimension value if not configured
      let mdValue = measureDimValue;
      if (!mdValue) {
        const mdMembers = VDTDataParser.getMeasureDimensionMembers(dataBinding, parsedMeta);
        if (mdMembers.length > 0) mdValue = mdMembers[0].id;
      }

      // Helper: populate a monthly array from month members for a given version
      const fillMonthly = (arr, members, measureKey, version) => {
        let hasData = false;
        members.forEach(tm => {
          if (!tm.calMonth) return;
          const idx = parseInt(tm.calMonth.substring(4)) - 1;
          if (idx < 0 || idx >= 12) return;
          const val = VDTDataParser.getNodeValue(dataBinding.data, parsedMeta, measureKey, mdValue, version, tm.id);
          if (val) { arr[idx] = val.value; hasData = true; }
        });
        return hasData;
      };

      // Helper: get full year value (year-level row or sum of months)
      const getFullYear = (members, yearMems, measureKey, version, year) => {
        // Try year-level row first
        if (yearMems.length > 0 && year) {
          const ym = yearMems.find(y => y.year === year || y.id.indexOf("[" + year + "]") >= 0);
          if (ym) {
            const val = VDTDataParser.getNodeValue(dataBinding.data, parsedMeta, measureKey, mdValue, version, ym.id);
            if (val) return val;
          }
        }
        // Fall back to summing months
        const ids = members.map(m => m.id);
        if (ids.length > 0) return VDTDataParser.aggregateNodeValues(dataBinding.data, parsedMeta, measureKey, mdValue, version, ids);
        return null;
      };

      // Build nodes from config
      const nodeMap = {};
      config.nodes.forEach(n => {
        nodeMap[n.id] = {
          id: n.id,
          name: n.name,
          unit: n.unit || "",
          accountId: n.accountId || null,
          measureKey: null,
          inputEnabled: !!n.inputEnabled,
          anchor: n.anchor || null,
          kpiDirection: n.kpiDirection || "higher",
          threshold: "neutral",
          thresholdArrow: "",
          baseValue: 0,
          value: 0,
          ds1: {
            fullYear: 0, monthValue: 0,
            monthlyOrig: new Array(12).fill(0),
            monthlyBase: new Array(12).fill(0),
            monthlyAdj: new Array(12).fill(0),
            monthly: new Array(12).fill(0)
          },
          ds2: {
            fullYear: 0, monthValue: 0,
            monthly: new Array(12).fill(0)
          },
          displayRows: [],
          sliderPct: 0,
          changeLog: [],
          sparkTrend: "neutral",
          sparkPath: "M0,24 L17,24 L34,24 L51,24 L68,24 L85,24 L102,24 L120,24",
          children: [],
          childIds: n.childIds || []
        };
      });

      // Populate values from SAC data binding
      for (const id in nodeMap) {
        const node = nodeMap[id];
        if (!node.accountId) continue;

        const measureKey = VDTDataParser.findMeasureKeyByAccountId(parsedMeta, node.accountId);
        if (!measureKey) continue;
        node.measureKey = measureKey;

        // DS1: populate monthly and full year
        const ds1HasMonthly = fillMonthly(node.ds1.monthlyOrig, ds1Months, measureKey, ds1Version);
        if (ds1HasMonthly) {
          node.ds1.monthlyBase = node.ds1.monthlyOrig.slice();
          node.ds1.monthly = node.ds1.monthlyOrig.slice();
          node.ds1.fullYear = node.ds1.monthly.reduce((a, b) => a + b, 0);
          node.ds1.monthValue = node.ds1.monthly[defaultMonthIdx] || 0;
        } else {
          const fyVal = getFullYear(ds1Months, yearMembers, measureKey, ds1Version, ds1Year);
          if (fyVal) {
            node.ds1.fullYear = fyVal.value;
            node.unit = fyVal.unit || node.unit;
          }
        }

        // DS2: populate monthly and full year (if configured)
        if (ds2Version) {
          const ds2HasMonthly = fillMonthly(node.ds2.monthly, ds2Months, measureKey, ds2Version);
          if (ds2HasMonthly) {
            node.ds2.fullYear = node.ds2.monthly.reduce((a, b) => a + b, 0);
            node.ds2.monthValue = node.ds2.monthly[defaultMonthIdx] || 0;
          } else {
            const fyVal = getFullYear(ds2Months, yearMembers, measureKey, ds2Version, ds2Year);
            if (fyVal) node.ds2.fullYear = fyVal.value;
          }
        }

        // Detect unit from DS1 if not already set
        if (!node.unit) {
          const anyVal = VDTDataParser.getNodeValue(dataBinding.data, parsedMeta, measureKey, mdValue, ds1Version, ds1Months[0]?.id);
          if (anyVal) node.unit = anyVal.unit || "";
        }

        // Build sparkline from DS1 monthly data
        this._buildSparkline(node);

        // Build display rows
        node.displayRows = this._buildDisplayRows(node, valueRowsConfig);
        node.value = node.displayRows.length > 0 ? node.displayRows[0].value : node.ds1.fullYear;
        node.baseValue = node.value;
      }

      // Wire up parent-child relationships
      for (const id in nodeMap) {
        const node = nodeMap[id];
        node.children = (node.childIds || []).map(cid => nodeMap[cid]).filter(Boolean);
      }

      // Find root (node not referenced as any child)
      const allChildIds = new Set();
      for (const id in nodeMap) {
        (nodeMap[id].childIds || []).forEach(cid => allChildIds.add(cid));
      }
      let root = null;
      for (const id in nodeMap) {
        if (!allChildIds.has(id)) { root = nodeMap[id]; break; }
      }

      // Recalculate computed nodes (propagates both ds1 and ds2)
      if (root) this.recalcParents(root);

      // Determine thresholds (DS1 fullYear vs DS2 fullYear)
      if (root) this._updateThresholds(root, widgetProps);

      // Store planning context for write-back (uses DS1)
      this._planningContext = {
        parsedMeta,
        monthMembers: ds1Months,
        primaryVersion: ds1Version,
        mdValue,
        accountDimId: parsedMeta.accounts ? Object.values(parsedMeta.accounts)[0]?.sacId?.match(/^\[([^\]]+)\]/)?.[1] || "Account" : "Account",
        versionDimId: parsedMeta.versionDimKey ? (parsedMeta.dimensions[parsedMeta.versionDimKey]?.id || "Version") : "Version",
        timeDimId: parsedMeta.timeDimKey ? (parsedMeta.dimensions[parsedMeta.timeDimKey]?.id || "Time") : "Time"
      };

      this.treeData = root;
      this._buildIndex(root);
      return root;
    }

    // Build sparkline SVG path from DS1 monthly data
    _buildSparkline(node) {
      const vals = node.ds1.monthly;
      const hasData = vals.some(v => v !== 0);
      if (!hasData) return;

      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const range = max - min || 1;
      const w = 120, h = 48, pad = 4;

      const points = vals.map((v, i) => {
        const x = Math.round((i / 11) * w);
        const y = Math.round(pad + (1 - (v - min) / range) * (h - pad * 2));
        return { x, y };
      });

      node.sparkPath = "M" + points.map(p => p.x + "," + p.y).join(" L");

      // Determine trend from first half avg vs second half avg
      const firstHalf = vals.slice(0, 6).reduce((a, b) => a + b, 0);
      const secondHalf = vals.slice(6).reduce((a, b) => a + b, 0);
      if (secondHalf > firstHalf * 1.02) node.sparkTrend = "positive";
      else if (secondHalf < firstHalf * 0.98) node.sparkTrend = "negative";
      else node.sparkTrend = "neutral";
    }

    // Build display rows for a node based on valueRows config
    _buildDisplayRows(node, valueRowsConfig) {
      return (valueRowsConfig || this._valueRowsConfig || []).map(rowDef => {
        const ds = rowDef.dataSet === 2 ? node.ds2 : node.ds1;
        const val = rowDef.timeVariant === "month" ? ds.monthValue : ds.fullYear;
        return { label: rowDef.label, value: val, dataSet: rowDef.dataSet, timeVariant: rowDef.timeVariant };
      });
    }

    // Build tree from static demo data (no data binding)
    buildDemoTree() {
      const demo = {
        nodes: [
          { id: "net-profit", name: "Net Profit", unit: "EUR", anchor: { type: "calc", symbol: "\u2212" },
            comparisons: [{ label: "PY" }, { label: "Month PY" }], childIds: ["gross-margin", "opex"] },
          { id: "gross-margin", name: "Gross Margin", unit: "EUR", anchor: { type: "calc", symbol: "\u2212" },
            comparisons: [{ label: "PY" }, { label: "Month PY" }], childIds: ["total-revenue", "cogs"] },
          { id: "total-revenue", name: "Total Revenue", unit: "EUR", anchor: { type: "data" },
            comparisons: [{ label: "PY" }, { label: "Month PY" }], childIds: ["rev-domestic", "rev-intl"] },
          { id: "rev-domestic", name: "Revenue Domestic", unit: "EUR", inputEnabled: true,
            comparisons: [{ label: "PY" }, { label: "Month PY" }] },
          { id: "rev-intl", name: "Revenue International", unit: "EUR", inputEnabled: true,
            comparisons: [{ label: "PY" }, { label: "Month PY" }] },
          { id: "cogs", name: "Cost of Goods Sold", unit: "EUR", inputEnabled: true,
            comparisons: [{ label: "PY" }, { label: "Month PY" }] },
          { id: "opex", name: "Operating Expenses", unit: "EUR", anchor: { type: "calc", symbol: "+" },
            comparisons: [{ label: "PY" }, { label: "Month PY" }], childIds: ["personnel", "other-opex"] },
          { id: "personnel", name: "Personnel Costs", unit: "EUR", inputEnabled: true,
            comparisons: [{ label: "PY" }, { label: "Month PY" }] },
          { id: "other-opex", name: "Other OpEx", unit: "EUR", inputEnabled: true,
            comparisons: [{ label: "PY" }, { label: "Month PY" }] }
        ]
      };

      // Demo values
      const vals = {
        "rev-domestic":  { value: 765800, comps: [720400, 60100] },
        "rev-intl":      { value: 480000, comps: [459800, 38100] },
        "cogs":          { value: 782400, comps: [720100, 61500] },
        "personnel":     { value: 142000, comps: [148200, 11800] },
        "other-opex":    { value: 58000,  comps: [63300, 4800] }
      };

      // Set leaf values
      const nodeMap = {};
      demo.nodes.forEach(n => {
        nodeMap[n.id] = n;
        n.baseValue = 0; n.value = 0; n.threshold = "neutral";
        n.ds1 = {
          fullYear: 0, monthValue: 0,
          monthlyOrig: new Array(12).fill(0), monthlyBase: new Array(12).fill(0),
          monthlyAdj: new Array(12).fill(0), monthly: new Array(12).fill(0)
        };
        n.ds2 = { fullYear: 0, monthValue: 0, monthly: new Array(12).fill(0) };
        n.displayRows = [];
        n.sliderPct = 0; n.changeLog = [];
        n.sparkTrend = "neutral";
        n.sparkPath = "M0,24 L17,24 L34,24 L51,24 L68,24 L85,24 L102,24 L120,24";
        n.children = [];
      });

      for (const id in vals) {
        const node = nodeMap[id];
        const v = vals[id];
        node.baseValue = v.value; node.value = v.value;
        node.ds1.fullYear = v.value;
        this._initMonthly(node, v.value);
        // Set DS2 from demo comparison values
        if (v.comps[0]) { node.ds2.fullYear = v.comps[0]; }
        node.displayRows = [
          { label: "Current", value: v.value, dataSet: 1, timeVariant: "fullYear" },
          { label: "Comparison", value: v.comps[0] || 0, dataSet: 2, timeVariant: "fullYear" }
        ];
      }

      // Wire children
      demo.nodes.forEach(n => {
        n.children = (n.childIds || []).map(cid => nodeMap[cid]).filter(Boolean);
      });

      const root = nodeMap["net-profit"];
      this.recalcParents(root);
      this._updateThresholds(root);
      this._setDemoSparklines(root);
      this.treeData = root;
      this._buildIndex(root);
      return root;
    }

    _initMonthly(node, yearValue) {
      const m = Math.round(yearValue / 12);
      for (let i = 0; i < 12; i++) { node.ds1.monthlyOrig[i] = m; node.ds1.monthlyBase[i] = m; node.ds1.monthly[i] = m; }
      node.ds1.monthlyOrig[11] += (yearValue - m * 12);
      node.ds1.monthlyBase[11] = node.ds1.monthlyOrig[11];
      node.ds1.monthly[11] = node.ds1.monthlyOrig[11];
    }

    // Store parsed metadata for external access (e.g., populating styling panel dropdowns)
    getParsedMetadata(dataBinding, config) {
      return VDTDataParser.parseMetadata(dataBinding.metadata, config);
    }

    _buildIndex(node) {
      if (!node) return;
      this.nodeIndex[node.id] = node;
      if (node.children) node.children.forEach(c => this._buildIndex(c));
    }

    findNode(id) { return this.nodeIndex[id] || null; }

    // Extract 0-based month index from a day-level time member
    // Day IDs look like: "[Posting_Date].[YMD].&[2026-03-15]" — extract month from the date
    // Or the parentId might be a month-level ID with CALMONTH
    _extractMonthFromDay(dayMember) {
      // Try parentId first (parent of a day is usually a month node)
      if (dayMember.parentId) {
        const cmMatch = dayMember.parentId.match(/\[(\d{6})\]$/);
        if (cmMatch) return parseInt(cmMatch[1].substring(4)) - 1;
      }
      // Try parsing date from the day ID itself
      const dateMatch = dayMember.id.match(/\[(\d{4})-(\d{2})-\d{2}\]$/);
      if (dateMatch) return parseInt(dateMatch[2]) - 1;
      // Try YYYYMMDD format
      const dateMatch2 = dayMember.id.match(/\[(\d{4})(\d{2})\d{2}\]$/);
      if (dateMatch2) return parseInt(dateMatch2[2]) - 1;
      return -1;
    }

    recomputeMonthly(node) {
      // Simulation applies to DS1 only
      for (let i = 0; i < 12; i++) {
        node.ds1.monthlyBase[i] = Math.round(node.ds1.monthlyOrig[i] * (1 + node.sliderPct / 100));
        node.ds1.monthly[i] = node.ds1.monthlyBase[i] + node.ds1.monthlyAdj[i];
      }
      node.ds1.fullYear = node.ds1.monthly.reduce((a, b) => a + b, 0);
      node.ds1.monthValue = node.ds1.monthly[this._defaultMonthIdx] || 0;
      // Recompute display rows and primary value
      node.displayRows = this._buildDisplayRows(node);
      node.value = node.displayRows.length > 0 ? node.displayRows[0].value : node.ds1.fullYear;
    }

    // Helper: apply operator across an array of child values
    _applyOp(op, childValues) {
      if (childValues.length === 0) return 0;
      let result = childValues[0];
      for (let j = 1; j < childValues.length; j++) {
        if (op === "+") result += childValues[j];
        else if (op === "\u2212") result -= childValues[j];
        else if (op === "\u00d7") result *= childValues[j];
        else if (op === "\u00f7" && childValues[j] !== 0) result /= childValues[j];
      }
      return result;
    }

    recalcParents(root) {
      if (!root.children || root.children.length === 0) return;
      root.children.forEach(c => this.recalcParents(c));
      if (!root.anchor) return;
      const op = (root.anchor.type === "data") ? "+" : root.anchor.symbol;

      // Propagate DS1
      for (let m = 0; m < 12; m++) {
        root.ds1.monthly[m] = this._applyOp(op, root.children.map(c => c.ds1.monthly[m]));
      }
      root.ds1.fullYear = root.ds1.monthly.reduce((a, b) => a + b, 0);
      root.ds1.monthValue = root.ds1.monthly[this._defaultMonthIdx] || 0;

      // Propagate DS2
      for (let m = 0; m < 12; m++) {
        root.ds2.monthly[m] = this._applyOp(op, root.children.map(c => c.ds2.monthly[m]));
      }
      root.ds2.fullYear = root.ds2.monthly.reduce((a, b) => a + b, 0);
      root.ds2.monthValue = root.ds2.monthly[this._defaultMonthIdx] || 0;

      // Recompute sparkline, display rows and primary value
      this._buildSparkline(root);
      root.displayRows = this._buildDisplayRows(root);
      root.value = root.displayRows.length > 0 ? root.displayRows[0].value : root.ds1.fullYear;
      root.baseValue = root.baseValue || root.value;
    }

    _updateThresholds(node, widgetProps) {
      if (!node) return;
      const ds1FY = node.ds1.fullYear;
      const ds2FY = node.ds2.fullYear;
      // kpiDirection: "higher" (revenue — growth is good) or "lower" (cost — decline is good)
      const direction = node.kpiDirection || "higher";

      if (ds2FY !== 0) {
        const changePct = ((ds1FY - ds2FY) / Math.abs(ds2FY)) * 100;
        const isUp = changePct >= 0;

        // Determine if movement is favorable based on KPI direction
        const favorable = (direction === "higher") ? isUp : !isUp;

        const thPos = (widgetProps && widgetProps.thresholdPositive) || 5;
        const thNeg = (widgetProps && widgetProps.thresholdNegative) || -5;
        const absPct = Math.abs(changePct);

        if (favorable && absPct >= thPos) node.threshold = "positive";
        else if (!favorable && absPct >= Math.abs(thNeg)) node.threshold = "negative";
        else node.threshold = "warning";

        node.thresholdArrow = isUp ? "▲" : "▼";
      } else {
        node.thresholdArrow = "";
      }
      if (node.children) node.children.forEach(c => this._updateThresholds(c, widgetProps));
    }

    _setDemoSparklines(node) {
      const sparklines = {
        "net-profit": { trend: "positive", path: "M0,38 L17,35 L34,30 L51,32 L68,25 L85,18 L102,14 L120,8" },
        "gross-margin": { trend: "neutral", path: "M0,20 L17,22 L34,18 L51,24 L68,22 L85,26 L102,25 L120,24" },
        "total-revenue": { trend: "positive", path: "M0,40 L17,36 L34,32 L51,30 L68,26 L85,20 L102,16 L120,10" },
        "rev-domestic": { trend: "positive", path: "M0,36 L17,34 L34,30 L51,28 L68,24 L85,20 L102,18 L120,12" },
        "rev-intl": { trend: "positive", path: "M0,34 L17,32 L34,30 L51,28 L68,25 L85,22 L102,20 L120,16" },
        "cogs": { trend: "negative", path: "M0,35 L17,33 L34,30 L51,26 L68,20 L85,15 L102,12 L120,8" },
        "opex": { trend: "neutral", path: "M0,22 L17,24 L34,22 L51,25 L68,24 L85,26 L102,25 L120,26" },
        "personnel": { trend: "neutral", path: "M0,24 L17,24 L34,23 L51,24 L68,24 L85,23 L102,24 L120,24" },
        "other-opex": { trend: "positive", path: "M0,18 L17,20 L34,22 L51,26 L68,28 L85,30 L102,34 L120,36" }
      };
      if (sparklines[node.id]) {
        node.sparkTrend = sparklines[node.id].trend;
        node.sparkPath = sparklines[node.id].path;
      }
      if (node.children) node.children.forEach(c => this._setDemoSparklines(c));
    }

    getChangedValues() {
      const changes = [];
      this._collectChanges(this.treeData, changes);

      const ctx = this._planningContext;
      return {
        planningContext: ctx ? {
          accountDimension: ctx.accountDimId,
          versionDimension: ctx.versionDimId,
          timeDimension: ctx.timeDimId,
          version: ctx.primaryVersion,
          measureDimValue: ctx.mdValue
        } : null,
        changes,
        // Flat list of per-month write-back entries ready for setUserInput
        writeBackEntries: this._buildWriteBackEntries(changes)
      };
    }

    _collectChanges(node, changes) {
      if (!node) return;
      if (node.changeLog.length > 0 && node.accountId) {
        changes.push({
          nodeId: node.id,
          name: node.name,
          accountId: node.accountId,
          measureKey: node.measureKey,
          originalValue: node.baseValue,
          newValue: node.value,
          monthlyOrig: node.ds1.monthlyOrig.slice(),
          monthly: node.ds1.monthly.slice()
        });
      }
      if (node.children) node.children.forEach(c => this._collectChanges(c, changes));
    }

    _buildWriteBackEntries(changes) {
      const ctx = this._planningContext;
      if (!ctx) return [];

      // Use leaf-level time members (months, quarters, or years depending on expansion)
      const leafMembers = ctx.monthMembers; // these are now leaf-level members
      const hasLeafMembers = leafMembers && leafMembers.length > 0;

      const entries = [];
      changes.forEach(ch => {
        if (!ch.accountId || !ch.measureKey) return;

        const acctInfo = ctx.parsedMeta.accounts[ch.measureKey];
        if (!acctInfo) return;

        // Skip parent/node accounts — SAC only allows write to leaf accounts
        if (acctInfo.isNode) return;

        if (hasLeafMembers) {
          // Per-period write-back: match monthly array slots to leaf time members
          for (let i = 0; i < 12; i++) {
            const diff = ch.monthly[i] - ch.monthlyOrig[i];
            if (Math.abs(diff) < 0.5) continue;

            // Find the leaf time member for this slot
            const monthStr = String(i + 1).padStart(2, "0");
            const timeMember = leafMembers.find(m => m.calMonth && m.calMonth.endsWith(monthStr));
            if (!timeMember) continue;

            entries.push({
              accountId: acctInfo.cleanId,
              accountSacId: acctInfo.sacId,
              timeMemberId: timeMember.id,
              timeLabel: timeMember.label,
              calMonth: timeMember.calMonth,
              version: ctx.primaryVersion,
              measureDimValue: ctx.mdValue,
              originalValue: ch.monthlyOrig[i],
              newValue: ch.monthly[i],
              delta: diff
            });
          }
        } else {
          // Aggregate write-back: no time breakdown, write total delta
          const totalDiff = ch.newValue - ch.originalValue;
          if (Math.abs(totalDiff) < 0.5) return;

          entries.push({
            accountId: acctInfo.cleanId,
            accountSacId: acctInfo.sacId,
            timeMemberId: "",
            timeLabel: "(all)",
            calMonth: "",
            version: ctx.primaryVersion,
            measureDimValue: ctx.mdValue,
            originalValue: ch.originalValue,
            newValue: ch.newValue,
            delta: totalDiff
          });
        }
      });
      return entries;
    }
  }

  // ── VDT Renderer ──
  class VDTRenderer {
    constructor(engine) {
      this.engine = engine;
    }

    fmt(n) { return Math.round(n).toLocaleString("en-US"); }
    areaPath(p) { return p + " L120,48 L0,48 Z"; }

    computeVariance(currentValue, refValue, unit) {
      const diff = currentValue - refValue;
      const pct = refValue !== 0 ? (diff / Math.abs(refValue)) * 100 : 0;
      const dir = diff >= 0 ? "positive" : "negative";
      const arrow = diff >= 0 ? "&#9650;" : "&#9660;";
      const sign = pct >= 0 ? "+" : "";
      return { refDisplay: this.fmt(refValue) + " " + unit, varDisplay: this.fmt(Math.abs(diff)), pctDisplay: sign + pct.toFixed(1) + "%", dir, arrow };
    }

    impactPct(node) {
      if (node.baseValue === 0) return 0;
      return ((node.value - node.baseValue) / Math.abs(node.baseValue)) * 100;
    }

    renderNode(node) {
      // Build display rows HTML (replaces old comparison HTML)
      const rowsHtml = (node.displayRows || []).map((row, idx) => {
        // Find a paired row in the opposite data set with same timeVariant for variance
        const pairRow = node.displayRows.find((r, j) =>
          j !== idx && r.dataSet !== row.dataSet && r.timeVariant === row.timeVariant
        );
        let varHtml = '<span class="vdt-node__row-variance"></span>';
        if (pairRow) {
          const v = this.computeVariance(row.value, pairRow.value, node.unit);
          varHtml = `<span class="vdt-node__row-variance"><span class="vdt-node__variance vdt-node__variance--${v.dir}"><span class="vdt-node__variance-arrow">${v.arrow}</span><span>${v.varDisplay}</span><span>(${v.pctDisplay})</span></span></span>`;
        }
        return `<div class="vdt-node__value-row" data-row-idx="${idx}" data-node-id="${node.id}">
          <span class="vdt-node__row-label">${row.label}</span>
          <span class="vdt-node__row-value">${this.fmt(row.value)} ${node.unit}</span>
          ${varHtml}
        </div>`;
      }).join("");

      let anchorHtml = "", toggleHtml = "";
      if (node.children && node.children.length > 0) {
        if (node.anchor && node.anchor.type === "data") {
          anchorHtml = `<div class="vdt-node__anchor vdt-node__anchor--data"><svg viewBox="0 0 16 16" width="11" height="11" fill="white"><ellipse cx="8" cy="4" rx="6" ry="2.5" stroke="white" stroke-width="0.8" fill="none"/><path d="M2,4 v8 c0,1.38 2.69,2.5 6,2.5 s6-1.12 6-2.5 v-8" stroke="white" stroke-width="0.8" fill="none"/><path d="M2,8 c0,1.38 2.69,2.5 6,2.5 s6-1.12 6-2.5" stroke="white" stroke-width="0.8" fill="none"/></svg></div>`;
        } else if (node.anchor) {
          anchorHtml = `<div class="vdt-node__anchor vdt-node__anchor--calc">${node.anchor.symbol}</div>`;
        }
        toggleHtml = `<div class="vdt-node__toggle vdt-node__toggle--expanded" data-node-id="${node.id}"></div>`;
      }

      let inputHtml = "";
      if (node.inputEnabled) {
        inputHtml = `<div class="vdt-node__input"><div class="vdt-node__slider-wrap"><input type="range" class="vdt-node__slider" min="-25" max="25" value="0" step="0.5" data-slider-for="${node.id}" /><span class="vdt-node__slider-pct" data-pct-for="${node.id}">0.0%</span></div><button class="vdt-node__detail-btn" data-detail-for="${node.id}" title="Monthly detail"><svg viewBox="0 0 16 16"><path d="M2 4h12v1H2zm0 3.5h12v1H2zm0 3.5h12v1H2z"/></svg></button></div>`;
      }

      let detailHtml = "";
      if (node.inputEnabled) {
        let monthRows = "";
        for (let i = 0; i < 12; i++) {
          monthRows += `<tr><td><span class="vdt-node__detail-month-label">${MONTHS[i]}</span></td><td><input type="text" class="vdt-node__detail-month-input" data-month-input="${node.id}" data-month-idx="${i}" value="${this.fmt(node.ds1.monthly[i])}" /></td><td><span class="vdt-node__detail-month-delta vdt-node__detail-month-delta--neutral" data-month-delta="${node.id}" data-month-idx="${i}">-</span></td></tr>`;
        }
        detailHtml = `<div class="vdt-node__detail-panel" data-detail-panel="${node.id}"><div class="vdt-node__detail-header"><span class="vdt-node__detail-title">Monthly Breakdown</span><span class="vdt-node__detail-total" data-detail-total="${node.id}">Total: ${this.fmt(node.value)} ${node.unit}</span></div><table class="vdt-node__detail-table"><thead><tr><th>Month</th><th>Value</th><th>Change</th></tr></thead><tbody>${monthRows}</tbody></table></div>`;
      }

      // Design mode buttons (hidden until .vdt-design-mode is set on root)
      const designHtml = `<button class="vdt-design-add-child" data-design-add="${node.id}" title="Add child node">+</button><button class="vdt-design-edit" data-design-edit="${node.id}" title="Edit node">&#9998;</button><button class="vdt-design-del" data-design-del="${node.id}" title="Delete node">&times;</button>`;

      return `<div class="vdt-node-wrap" data-node-id="${node.id}"><div class="vdt-node"><div class="vdt-node__threshold vdt-node__threshold--${node.threshold}">${node.thresholdArrow ? '<span class="vdt-node__threshold-arrow">' + node.thresholdArrow + '</span>' : ''}</div><div class="vdt-node__header"><span class="vdt-node__measure-name">${node.name}</span><span class="vdt-node__measure-value"><span class="vdt-node__value">${this.fmt(node.value)}</span><span class="vdt-node__unit">${node.unit}</span></span></div><div class="vdt-node__body"><div class="vdt-node__microchart"><svg viewBox="0 0 120 48" preserveAspectRatio="none"><path class="sparkline-area sparkline-area--${node.sparkTrend}" d="${this.areaPath(node.sparkPath)}"/><path class="sparkline sparkline--${node.sparkTrend}" d="${node.sparkPath}"/></svg></div><div class="vdt-node__display-rows">${rowsHtml}</div></div>${inputHtml}</div>${detailHtml}${anchorHtml}${toggleHtml}${designHtml}<div class="vdt-design-popup" data-design-popup="${node.id}"></div></div>`;
    }

    renderTree(node) {
      let html = `<div class="vdt-level" data-level-id="${node.id}">`;
      html += this.renderNode(node);
      if (node.children && node.children.length > 0) {
        html += `<div class="vdt-level__gap"></div><div class="vdt-level__children" data-children-of="${node.id}">`;
        node.children.forEach(child => { html += this.renderTree(child); });
        html += `</div>`;
      }
      html += `</div>`;
      return html;
    }

    drawConnectors(node, rootEl, svgEl, zoom) {
      const z = zoom || 1;
      if (!node.children || node.children.length === 0) return;
      const parentWrap = rootEl.querySelector(`.vdt-node-wrap[data-node-id="${node.id}"]`);
      const childrenContainer = rootEl.querySelector(`[data-children-of="${node.id}"]`);
      if (!parentWrap || !childrenContainer || childrenContainer.style.display === "none") return;
      const anchor = parentWrap.querySelector(".vdt-node__anchor");
      if (!anchor) return;
      const rootRect = rootEl.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const startX = (anchorRect.right - rootRect.left) / z;
      const startY = (anchorRect.top + anchorRect.height / 2 - rootRect.top) / z;
      const childYs = [], endXs = [];
      node.children.forEach(child => {
        const cw = rootEl.querySelector(`.vdt-node-wrap[data-node-id="${child.id}"]`);
        if (!cw) return;
        const cr = cw.getBoundingClientRect();
        endXs.push((cr.left - rootRect.left) / z);
        childYs.push((cr.top + cr.height / 2 - rootRect.top) / z);
      });
      if (childYs.length === 0) return;
      const midX = startX + (endXs[0] - startX) / 2;
      svgEl.innerHTML += `<line x1="${startX}" y1="${startY}" x2="${midX}" y2="${startY}" stroke="#c4c6c8" stroke-width="1" />`;
      const topY = Math.min(startY, ...childYs);
      const bottomY = Math.max(startY, ...childYs);
      if (topY !== bottomY) svgEl.innerHTML += `<line x1="${midX}" y1="${topY}" x2="${midX}" y2="${bottomY}" stroke="#c4c6c8" stroke-width="1" />`;
      childYs.forEach((cy, i) => {
        svgEl.innerHTML += `<line x1="${midX}" y1="${cy}" x2="${endXs[i]}" y2="${cy}" stroke="#c4c6c8" stroke-width="1" />`;
      });
      node.children.forEach(child => this.drawConnectors(child, rootEl, svgEl, z));
    }
  }

  // ── Main Web Component ──
  class ValueDriverTreeWidget extends HTMLElement {
    constructor() {
      super();
      this._shadowRoot = this.attachShadow({ mode: "open" });
      this._shadowRoot.appendChild(template.content.cloneNode(true));

      this._root = this._shadowRoot.querySelector(".vdt-root");
      this._treeRoot = this._shadowRoot.getElementById("treeRoot");
      this._treeContainer = this._shadowRoot.getElementById("treeContainer");
      this._connectorsSvg = this._shadowRoot.getElementById("connectorsSvg");
      this._emptyState = this._shadowRoot.getElementById("emptyState");

      this._engine = new VDTEngine();
      this._renderer = new VDTRenderer(this._engine);
      this._dataBinding = null;
      this._props = {};
      this._designMode = false;
      this._parsedMeta = null;

      // Config panel elements
      this._configOverlay = this._shadowRoot.getElementById("configOverlay");
      this._configToggle = this._shadowRoot.getElementById("configToggle");

      // Zoom + minimap elements
      this._viewport = this._shadowRoot.getElementById("viewport");
      this._zoomWrapper = this._shadowRoot.getElementById("zoomWrapper");
      this._zoomBar = this._shadowRoot.getElementById("zoomBar");
      this._zoomLabel = this._shadowRoot.getElementById("zoomLabel");
      this._minimap = this._shadowRoot.getElementById("minimap");
      this._minimapCanvas = this._shadowRoot.getElementById("minimapCanvas");
      this._minimapViewportEl = this._shadowRoot.getElementById("minimapViewport");
      this._zoomLevel = 1;
      this._minimapVisible = true;

      this._bindEvents();
      this._bindConfigEvents();
      this._bindZoomEvents();
    }

    // ── SAC Lifecycle ──
    onCustomWidgetBeforeUpdate(changedProperties) {
      this._props = { ...this._props, ...changedProperties };
      // SAC sets designMode when in edit mode
      if (changedProperties.designMode !== undefined) {
        this._designMode = changedProperties.designMode;
      }
    }

    onCustomWidgetAfterUpdate(changedProperties) {
      // Show/hide config toggle based on design mode
      if (this._designMode) {
        this._configToggle.classList.add("vdt-config-toggle--visible");
      } else {
        this._configToggle.classList.remove("vdt-config-toggle--visible");
        this._configOverlay.classList.remove("vdt-config-overlay--open");
      }

      // Skip full re-render if only read-only output properties changed (slider interaction)
      const keys = Object.keys(changedProperties);
      const outputOnly = keys.every(k => k === "changedValues" || k.startsWith("_"));
      if (outputOnly && keys.length > 0) return;

      this.render();
    }

    onCustomWidgetResize(width, height) {
      this._redrawConnectors();
      this._updateMinimap();
    }

    onCustomWidgetDestroy() {}

    // ── Data Binding Setter (SAC delivers data here) ──
    set dataBinding(value) {
      this._dataBinding = value;
      this._publishModelInfo();
      this.render();
    }

    get dataBinding() {
      return this._dataBinding;
    }

    // Extract model info from data binding and populate config panel + styling panel
    _publishModelInfo() {
      const db = this._dataBinding;
      if (!db || db.state !== "success") return;

      try {
        const parsedMeta = VDTDataParser.parseMetadata(db.metadata, this._props);
        this._parsedMeta = parsedMeta;

        // Build dimensions list (excluding @MeasureDimension)
        const dims = [];
        for (const key in parsedMeta.dimensions) {
          const d = parsedMeta.dimensions[key];
          if (d.id !== "@MeasureDimension") {
            dims.push({ id: d.id, description: d.description || d.id });
          }
        }

        // Build version members
        const versions = VDTDataParser.getVersionMembers(db, parsedMeta);

        // Build @MeasureDimension members
        const mdMembers = VDTDataParser.getMeasureDimensionMembers(db, parsedMeta);

        // Build account members
        const accounts = VDTDataParser.getAccountMembers(parsedMeta);

        // Extract available years from month members
        const monthMems = VDTDataParser.getTimeMembers(db, parsedMeta, "month");
        const yearSet = new Set();
        monthMems.forEach(m => { if (m.calMonth) yearSet.add(m.calMonth.substring(0, 4)); });
        const years = Array.from(yearSet).sort();

        // Populate config panel dropdowns (main widget - works in design mode)
        this._populateConfigDropdowns(dims, versions, mdMembers, accounts, years);

        // Also publish as JSON string properties for the styling panel (backward compat)
        this.dispatchEvent(new CustomEvent("propertiesChanged", {
          detail: {
            properties: {
              _availableDimensions: JSON.stringify(dims),
              _availableVersions: JSON.stringify(versions),
              _availableMeasureDims: JSON.stringify(mdMembers),
              _availableAccounts: JSON.stringify(accounts)
            }
          }
        }));
      } catch (e) {
        console.error("VDT: Error extracting model info", e);
      }
    }

    // Populate the in-widget config panel dropdowns and builder account list
    _populateConfigDropdowns(dims, versions, mdMembers, accounts, years) {
      const root = this._shadowRoot;
      this._accountList = accounts;

      // Dimension dropdowns
      ["cfgVersionDim", "cfgTimeDim"].forEach(selId => {
        const sel = root.getElementById(selId);
        if (!sel) return;
        const currentVal = sel.value;
        sel.innerHTML = '<option value="">(auto-detect)</option>';
        dims.forEach(d => {
          const opt = document.createElement("option");
          opt.value = d.id;
          opt.textContent = d.description || d.id;
          sel.appendChild(opt);
        });
        sel.value = currentVal || this._getConfigPropForSelect(selId);
      });

      // DS1/DS2 Version dropdowns
      ["cfgDs1Version", "cfgDs2Version"].forEach(selId => {
        const sel = root.getElementById(selId);
        if (!sel) return;
        const currentVal = sel.value;
        const isDs2 = selId === "cfgDs2Version";
        sel.innerHTML = isDs2 ? '<option value="">(none)</option>' : '<option value="">(first available)</option>';
        versions.forEach(v => {
          const opt = document.createElement("option");
          opt.value = v.id;
          opt.textContent = v.label || v.id;
          sel.appendChild(opt);
        });
        const savedVal = isDs2 ? this._props.ds2Version : (this._props.ds1Version || this._props.activeVersion);
        sel.value = currentVal || savedVal || "";
      });

      // DS1/DS2 Year dropdowns
      ["cfgDs1Year", "cfgDs2Year"].forEach(selId => {
        const sel = root.getElementById(selId);
        if (!sel) return;
        const currentVal = sel.value;
        const isDs2 = selId === "cfgDs2Year";
        sel.innerHTML = isDs2 ? '<option value="">(none)</option>' : '<option value="">(all available)</option>';
        (years || []).forEach(y => {
          const opt = document.createElement("option");
          opt.value = y;
          opt.textContent = y;
          sel.appendChild(opt);
        });
        const savedVal = isDs2 ? this._props.ds2Year : this._props.ds1Year;
        sel.value = currentVal || savedVal || "";
      });

      // Measure dropdown
      const mdSel = root.getElementById("cfgMeasure");
      if (mdSel) {
        const currentVal = mdSel.value;
        mdSel.innerHTML = '<option value="">(auto-detect)</option>';
        mdMembers.forEach(m => {
          const opt = document.createElement("option");
          opt.value = m.id;
          opt.textContent = m.label || m.id;
          mdSel.appendChild(opt);
        });
        mdSel.value = currentVal || this._props.measureDimValue || "";
      }

      // Populate account dropdown in builder
      this._populateBuilderAccountDropdown();

      // Render value rows editor
      this._renderValueRowsEditor();

      this._updateConfigDimStatus();
    }

    _populateBuilderAccountDropdown() {
      const sel = this._shadowRoot.getElementById("builderNewAccount");
      if (!sel) return;
      const currentVal = sel.value;
      sel.innerHTML = '<option value="">(calculated node)</option>';
      (this._accountList || []).forEach(a => {
        const opt = document.createElement("option");
        opt.value = a.cleanId;
        opt.textContent = a.label || a.cleanId;
        sel.appendChild(opt);
      });
      sel.value = currentVal;
    }

    _getConfigPropForSelect(selId) {
      if (selId === "cfgVersionDim") return this._props.versionDimension || "";
      if (selId === "cfgTimeDim") return this._props.timeDimension || "";
      return "";
    }

    _updateConfigDimStatus() {
      const root = this._shadowRoot;
      const statusEl = root.getElementById("cfgDimStatus");
      if (!statusEl) return;
      const ver = root.getElementById("cfgVersionDim").value;
      const time = root.getElementById("cfgTimeDim").value;
      if (ver && time) {
        statusEl.innerHTML = '<div class="vdt-config-status vdt-config-status--ok">All dimensions configured</div>';
      } else {
        const missing = [];
        if (!ver) missing.push("Version");
        if (!time) missing.push("Time");
        statusEl.innerHTML = '<div class="vdt-config-status vdt-config-status--warn">Auto-detecting: ' + missing.join(", ") + '</div>';
      }
    }

    // ── Visual Tree Builder ──

    // Internal builder state: flat array of node definitions
    // Each: { id, name, accountId, anchor, parentId, inputEnabled }
    _initBuilder() {
      this._builderNodes = [];
      this._builderNextId = 1;
      this._accountList = [];
      this._builderUserEdited = false;
    }

    _renderBuilderTree() {
      const container = this._shadowRoot.getElementById("builderTree");
      if (!container) return;
      if (!this._builderNodes || this._builderNodes.length === 0) {
        container.innerHTML = '<div class="vdt-config-hint">(empty — add a root node below)</div>';
        return;
      }

      // Build parent-child map
      const childMap = {};
      this._builderNodes.forEach(n => {
        if (n.childIds) n.childIds.forEach(cid => { childMap[cid] = n.id; });
      });

      // Find root nodes (not referenced as children)
      const roots = this._builderNodes.filter(n => !childMap[n.id]);

      const renderNode = (node, depth) => {
        const isCalc = !node.accountId;
        const typeClass = isCalc ? "calc" : "data";
        const icon = isCalc ? (node.anchor ? node.anchor.symbol : "+") : "&#9634;";
        const badge = isCalc ? "calculated" : node.accountId;
        const children = this._builderNodes.filter(n => (node.childIds || []).includes(n.id));

        let html = `<div class="vdt-builder-node vdt-builder-node--${typeClass}" data-builder-id="${node.id}">
          <div class="vdt-builder-node__header">
            <div class="vdt-builder-node__icon vdt-builder-node__icon--${typeClass}">${icon}</div>
            <span class="vdt-builder-node__label">${node.name}</span>
            <span class="vdt-builder-node__badge">${badge}</span>
            <div class="vdt-builder-node__actions">
              <button class="vdt-builder-node__btn" data-builder-edit="${node.id}" title="Edit">&#9998;</button>
              <button class="vdt-builder-node__btn vdt-builder-node__btn--del" data-builder-del="${node.id}" title="Remove">&times;</button>
            </div>
          </div>
          <div class="vdt-builder-edit" data-builder-edit-panel="${node.id}">
            <div class="vdt-config-field">
              <label>Name</label>
              <input type="text" data-builder-field="name" data-builder-id="${node.id}" value="${node.name}" />
            </div>`;

        if (isCalc) {
          const ops = ["+", "\u2212", "\u00d7", "\u00f7"];
          const currentOp = node.anchor ? node.anchor.symbol : "+";
          html += `<div class="vdt-config-field">
              <label>Operator</label>
              <select data-builder-field="operator" data-builder-id="${node.id}">
                ${ops.map(o => `<option value="${o}" ${o === currentOp ? "selected" : ""}>${o}</option>`).join("")}
              </select>
            </div>
            <div class="vdt-config-field">
              <label>Add Child</label>
              <div class="vdt-builder-add">
                <input type="text" class="vdt-builder-add__name" data-builder-child-name="${node.id}" placeholder="Child name" />
                <select data-builder-child-acct="${node.id}">
                  <option value="">(calculated)</option>
                  ${(this._accountList || []).map(a =>
                    `<option value="${a.cleanId}">${a.label || a.cleanId}</option>`
                  ).join("")}
                </select>
                <button class="vdt-builder-add__btn" data-builder-add-child="${node.id}">Add</button>
              </div>
            </div>`;
        } else {
          html += `<div class="vdt-config-field">
              <label>Account</label>
              <select data-builder-field="accountId" data-builder-id="${node.id}">
                ${(this._accountList || []).map(a =>
                  `<option value="${a.cleanId}" ${a.cleanId === node.accountId ? "selected" : ""}>${a.label || a.cleanId}</option>`
                ).join("")}
              </select>
            </div>
            <div class="vdt-config-field">
              <label><input type="checkbox" data-builder-field="inputEnabled" data-builder-id="${node.id}" ${node.inputEnabled ? "checked" : ""} /> Enable slider input</label>
            </div>`;
        }

        html += `<div class="vdt-config-field">
            <label>KPI Direction</label>
            <select data-builder-field="kpiDirection" data-builder-id="${node.id}">
              <option value="higher" ${(node.kpiDirection || "higher") === "higher" ? "selected" : ""}>Higher is better (e.g., Revenue)</option>
              <option value="lower" ${node.kpiDirection === "lower" ? "selected" : ""}>Lower is better (e.g., Cost)</option>
            </select>
          </div>`;

        html += `</div>`;

        if (children.length > 0) {
          html += `<div class="vdt-builder-node__children">`;
          children.forEach(c => { html += renderNode(c, depth + 1); });
          html += `</div>`;
        }

        html += `</div>`;
        return html;
      };

      container.innerHTML = roots.map(r => renderNode(r, 0)).join("");
    }

    _builderFindNode(id) {
      return (this._builderNodes || []).find(n => n.id === id) || null;
    }

    _builderMarkEdited() {
      this._builderUserEdited = true;
    }

    _builderRemoveNode(id) {
      this._builderMarkEdited();
      // Remove from parent's childIds
      this._builderNodes.forEach(n => {
        if (n.childIds) n.childIds = n.childIds.filter(cid => cid !== id);
      });
      // Remove the node and all its descendants
      const toRemove = new Set();
      const collect = (nid) => {
        toRemove.add(nid);
        const node = this._builderFindNode(nid);
        if (node && node.childIds) node.childIds.forEach(cid => collect(cid));
      };
      collect(id);
      this._builderNodes = this._builderNodes.filter(n => !toRemove.has(n.id));
    }

    _builderToConfig() {
      return { nodes: this._builderNodes.map(n => {
        const out = { id: n.id, name: n.name };
        if (n.accountId) out.accountId = n.accountId;
        if (n.unit) out.unit = n.unit;
        if (n.inputEnabled) out.inputEnabled = true;
        if (n.kpiDirection && n.kpiDirection !== "higher") out.kpiDirection = n.kpiDirection;
        if (n.anchor) out.anchor = n.anchor;
        if (n.childIds && n.childIds.length > 0) out.childIds = n.childIds;
        return out;
      })};
    }

    _builderGenerateId(name) {
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "node";
      let id = base;
      let i = 2;
      while (this._builderFindNode(id)) { id = base + "-" + i; i++; }
      return id;
    }

    // Config panel event bindings
    _bindConfigEvents() {
      const root = this._shadowRoot;
      this._initBuilder();

      // Toggle config panel + design mode on canvas
      root.getElementById("configToggle").addEventListener("click", () => {
        const isOpen = this._configOverlay.classList.toggle("vdt-config-overlay--open");
        this._root.classList.toggle("vdt-design-mode", isOpen);
      });
      root.getElementById("configClose").addEventListener("click", () => {
        this._configOverlay.classList.remove("vdt-config-overlay--open");
        this._root.classList.remove("vdt-design-mode");
      });

      // Dimension + data set dropdowns
      ["cfgVersionDim", "cfgTimeDim", "cfgTimeGranularity", "cfgMeasure",
       "cfgDs1Version", "cfgDs1Year", "cfgDs2Version", "cfgDs2Year", "cfgDefaultMonth"].forEach(selId => {
        root.getElementById(selId).addEventListener("change", () => {
          this._applyConfigDimensions();
        });
      });

      // Restore saved props
      const granSel = root.getElementById("cfgTimeGranularity");
      if (this._props.timeGranularity) granSel.value = this._props.timeGranularity;
      if (this._props.defaultMonth) root.getElementById("cfgDefaultMonth").value = this._props.defaultMonth;

      // Value rows editor
      this._renderValueRowsEditor();
      root.getElementById("cfgAddValueRow").addEventListener("click", () => {
        const rows = this._getValueRowsFromEditor();
        if (rows.length >= 4) return;
        rows.push({ dataSet: 1, timeVariant: "fullYear", label: "New Row" });
        this._renderValueRowsEditor(rows);
        this._applyConfigDimensions();
      });

      // Add root-level node
      root.getElementById("builderAddBtn").addEventListener("click", () => {
        const nameEl = root.getElementById("builderNewName");
        const acctEl = root.getElementById("builderNewAccount");
        const opEl = root.getElementById("builderNewOp");
        const name = nameEl.value.trim();
        if (!name) return;

        const accountId = acctEl.value || null;
        const node = {
          id: this._builderGenerateId(name),
          name: name,
          accountId: accountId,
          inputEnabled: !!accountId,
          childIds: []
        };
        if (!accountId) {
          node.anchor = { type: "calc", symbol: opEl.value };
        }

        // If there's a single root, add as child of that root; otherwise add as root
        const childMap = {};
        this._builderNodes.forEach(n => {
          if (n.childIds) n.childIds.forEach(cid => { childMap[cid] = n.id; });
        });
        const roots = this._builderNodes.filter(n => !childMap[n.id]);
        if (roots.length === 1 && !roots[0].accountId) {
          roots[0].childIds = roots[0].childIds || [];
          roots[0].childIds.push(node.id);
        }

        this._builderNodes.push(node);
        nameEl.value = "";
        acctEl.value = "";
        this._renderBuilderTree();
      });

      // Delegated events on builder tree
      root.getElementById("builderTree").addEventListener("click", (e) => {
        // Edit toggle
        const editBtn = e.target.closest("[data-builder-edit]");
        if (editBtn) {
          const id = editBtn.getAttribute("data-builder-edit");
          const panel = root.querySelector(`[data-builder-edit-panel="${id}"]`);
          if (panel) panel.classList.toggle("vdt-builder-edit--open");
          return;
        }

        // Delete
        const delBtn = e.target.closest("[data-builder-del]");
        if (delBtn) {
          const id = delBtn.getAttribute("data-builder-del");
          this._builderRemoveNode(id);
          this._renderBuilderTree();
          return;
        }

        // Add child to a calc node
        const addChildBtn = e.target.closest("[data-builder-add-child]");
        if (addChildBtn) {
          const parentId = addChildBtn.getAttribute("data-builder-add-child");
          const parent = this._builderFindNode(parentId);
          if (!parent) return;
          const nameEl = root.querySelector(`[data-builder-child-name="${parentId}"]`);
          const acctEl = root.querySelector(`[data-builder-child-acct="${parentId}"]`);
          const name = nameEl ? nameEl.value.trim() : "";
          if (!name) return;

          const accountId = acctEl ? acctEl.value || null : null;
          const child = {
            id: this._builderGenerateId(name),
            name: name,
            accountId: accountId,
            inputEnabled: !!accountId,
            childIds: []
          };
          if (!accountId) {
            child.anchor = { type: "calc", symbol: "+" };
          }

          parent.childIds = parent.childIds || [];
          parent.childIds.push(child.id);
          this._builderNodes.push(child);
          if (nameEl) nameEl.value = "";
          if (acctEl) acctEl.value = "";
          this._renderBuilderTree();
          return;
        }
      });

      // Delegated change events for inline editing
      root.getElementById("builderTree").addEventListener("change", (e) => {
        const id = e.target.getAttribute("data-builder-id");
        const field = e.target.getAttribute("data-builder-field");
        if (!id || !field) return;
        const node = this._builderFindNode(id);
        if (!node) return;

        if (field === "name") node.name = e.target.value;
        if (field === "accountId") node.accountId = e.target.value;
        if (field === "inputEnabled") node.inputEnabled = e.target.checked;
        if (field === "kpiDirection") node.kpiDirection = e.target.value;
        if (field === "operator") {
          node.anchor = { type: "calc", symbol: e.target.value };
        }
        this._renderBuilderTree();
      });

      // Apply button — convert builder state to treeConfig and push
      root.getElementById("cfgApply").addEventListener("click", () => {
        this._applyFullConfig();
      });

      // Load demo
      root.getElementById("cfgLoadDemo").addEventListener("click", () => {
        this._loadDemoConfig();
      });
    }

    _getConfigProps() {
      const root = this._shadowRoot;
      return {
        versionDimension: root.getElementById("cfgVersionDim").value,
        timeDimension: root.getElementById("cfgTimeDim").value,
        timeGranularity: root.getElementById("cfgTimeGranularity").value,
        measureDimValue: root.getElementById("cfgMeasure").value,
        ds1Version: root.getElementById("cfgDs1Version").value,
        ds1Year: root.getElementById("cfgDs1Year").value,
        ds2Version: root.getElementById("cfgDs2Version").value,
        ds2Year: root.getElementById("cfgDs2Year").value,
        defaultMonth: root.getElementById("cfgDefaultMonth").value,
        valueRows: JSON.stringify(this._getValueRowsFromEditor())
      };
    }

    _applyConfigDimensions() {
      const props = this._getConfigProps();
      this.dispatchEvent(new CustomEvent("propertiesChanged", {
        detail: { properties: props }
      }));
      this._updateConfigDimStatus();
    }

    // Value rows editor
    _renderValueRowsEditor(rows) {
      const container = this._shadowRoot.getElementById("cfgValueRows");
      if (!container) return;
      if (!rows) {
        try { rows = JSON.parse(this._props.valueRows || "[]"); } catch (e) { rows = []; }
      }
      if (rows.length === 0) {
        rows = [
          { dataSet: 1, timeVariant: "fullYear", label: "DS1 Full Year" },
          { dataSet: 2, timeVariant: "fullYear", label: "DS2 Full Year" }
        ];
      }
      container.innerHTML = rows.map((r, i) => `
        <div class="vdt-config-value-row" data-row-idx="${i}" style="display:flex;gap:4px;align-items:center;margin-bottom:4px;">
          <select data-vr-ds="${i}" style="width:60px;font-size:11px;padding:2px;">
            <option value="1" ${r.dataSet === 1 ? "selected" : ""}>DS1</option>
            <option value="2" ${r.dataSet === 2 ? "selected" : ""}>DS2</option>
          </select>
          <select data-vr-tv="${i}" style="width:80px;font-size:11px;padding:2px;">
            <option value="fullYear" ${r.timeVariant === "fullYear" ? "selected" : ""}>Full Year</option>
            <option value="month" ${r.timeVariant === "month" ? "selected" : ""}>Month</option>
          </select>
          <input type="text" data-vr-label="${i}" value="${r.label || ""}" style="flex:1;font-size:11px;padding:2px 4px;" placeholder="Label" />
          <button data-vr-del="${i}" style="font-size:11px;padding:1px 6px;cursor:pointer;">&times;</button>
        </div>
      `).join("");

      // Bind change/delete events
      container.querySelectorAll("select, input").forEach(el => {
        el.addEventListener("change", () => this._applyConfigDimensions());
      });
      container.querySelectorAll("[data-vr-del]").forEach(btn => {
        btn.addEventListener("click", () => {
          const idx = parseInt(btn.getAttribute("data-vr-del"));
          const current = this._getValueRowsFromEditor();
          current.splice(idx, 1);
          this._renderValueRowsEditor(current);
          this._applyConfigDimensions();
        });
      });
    }

    _getValueRowsFromEditor() {
      const container = this._shadowRoot.getElementById("cfgValueRows");
      if (!container) return [];
      const rows = [];
      container.querySelectorAll(".vdt-config-value-row").forEach(el => {
        const idx = el.getAttribute("data-row-idx");
        const ds = parseInt(el.querySelector(`[data-vr-ds="${idx}"]`)?.value || "1");
        const tv = el.querySelector(`[data-vr-tv="${idx}"]`)?.value || "fullYear";
        const label = el.querySelector(`[data-vr-label="${idx}"]`)?.value || "";
        rows.push({ dataSet: ds, timeVariant: tv, label: label });
      });
      return rows;
    }

    _applyFullConfig() {
      const root = this._shadowRoot;
      const statusEl = root.getElementById("cfgApplyStatus");

      if (!this._builderNodes || this._builderNodes.length === 0) {
        statusEl.innerHTML = '<div class="vdt-config-status vdt-config-status--warn">Add at least one node first</div>';
        return;
      }

      const config = this._builderToConfig();
      const treeConfig = JSON.stringify(config);
      const props = {
        ...this._getConfigProps(),
        treeConfig: treeConfig
      };

      // Update internal props immediately and re-render
      this._props = { ...this._props, ...props };
      this.render();

      this.dispatchEvent(new CustomEvent("propertiesChanged", {
        detail: { properties: props }
      }));

      this._builderUserEdited = false;
      statusEl.innerHTML = '<div class="vdt-config-status vdt-config-status--ok">Tree applied</div>';
      setTimeout(() => { statusEl.innerHTML = ""; }, 3000);
    }

    _loadDemoConfig() {
      this._builderNodes = [
        { id: "net-profit", name: "Net Profit", unit: "EUR", anchor: { type: "calc", symbol: "\u2212" }, childIds: ["gross-margin", "opex"] },
        { id: "gross-margin", name: "Gross Margin", unit: "EUR", anchor: { type: "calc", symbol: "\u2212" }, childIds: ["total-revenue", "cogs"] },
        { id: "total-revenue", name: "Total Revenue", unit: "EUR", anchor: { type: "data" }, childIds: ["rev-domestic", "rev-intl"] },
        { id: "rev-domestic", name: "Revenue Domestic", unit: "EUR", inputEnabled: true },
        { id: "rev-intl", name: "Revenue International", unit: "EUR", inputEnabled: true },
        { id: "cogs", name: "Cost of Goods Sold", unit: "EUR", inputEnabled: true },
        { id: "opex", name: "Operating Expenses", unit: "EUR", anchor: { type: "calc", symbol: "+" }, childIds: ["personnel", "other-opex"] },
        { id: "personnel", name: "Personnel Costs", unit: "EUR", inputEnabled: true },
        { id: "other-opex", name: "Other OpEx", unit: "EUR", inputEnabled: true }
      ];
      this._renderBuilderTree();
    }

    // ── Render ──
    render() {
      let tree = null;
      if (this._dataBinding && this._dataBinding.state === "success") {
        if (this._props.treeConfig) {
          // Real data mode with user-defined tree structure
          try {
            const config = JSON.parse(this._props.treeConfig);
            tree = this._engine.buildTree(config, this._dataBinding, this._props);
            // Sync to builder (only if user hasn't manually edited)
            if (!this._builderUserEdited) {
              this._builderNodes = (config.nodes || []).map(n => ({ ...n }));
              this._renderBuilderTree();
            }
          } catch (e) {
            console.error("VDT: Error parsing tree config", e);
          }
        }

        if (!tree) {
          // Auto-build a flat tree from available accounts (preview mode)
          tree = this._buildAutoTree();
        }
      }

      if (!tree) {
        // Demo mode — no data binding at all
        tree = this._engine.buildDemoTree();
      }

      if (!tree) {
        this._emptyState.style.display = "flex";
        this._treeRoot.style.display = "none";
        this._zoomBar.style.display = "none";
        this._minimap.classList.add("vdt-minimap--hidden");
        return;
      }

      this._emptyState.style.display = "none";
      this._treeRoot.style.display = "inline-block";
      this._zoomBar.style.display = "flex";
      if (this._minimapVisible) this._minimap.classList.remove("vdt-minimap--hidden");
      this._zoomWrapper.style.transform = `scale(${this._zoomLevel})`;
      this._treeContainer.innerHTML = this._renderer.renderTree(tree);
      requestAnimationFrame(() => {
        this._redrawConnectors();
        this._updateMinimap();
      });
    }

    // Auto-build tree from data binding accounts, respecting hierarchy if present
    _buildAutoTree() {
      const db = this._dataBinding;
      if (!db || db.state !== "success") return null;

      try {
        const parsedMeta = VDTDataParser.parseMetadata(db.metadata, this._props);
        const accounts = VDTDataParser.getAccountMembers(parsedMeta);
        if (accounts.length === 0) return null;

        // Check if any account has parentId — indicates hierarchy
        const hasHierarchy = accounts.some(a => a.parentCleanId);

        let config;
        if (hasHierarchy) {
          config = this._buildHierarchicalConfig(accounts);
        } else {
          config = this._buildFlatConfig(accounts);
        }

        // Always sync auto-tree to builder so config panel shows all nodes
        this._builderNodes = config.nodes.map(n => ({ ...n }));
        this._renderBuilderTree();

        return this._engine.buildTree(config, db, this._props);
      } catch (e) {
        console.error("VDT: Error auto-building tree", e);
        return null;
      }
    }

    _redrawConnectors() {
      if (!this._engine.treeData) return;
      this._connectorsSvg.innerHTML = "";
      this._connectorsSvg.setAttribute("width", this._treeRoot.offsetWidth);
      this._connectorsSvg.setAttribute("height", this._treeRoot.offsetHeight);
      this._renderer.drawConnectors(this._engine.treeData, this._treeRoot, this._connectorsSvg, this._zoomLevel);
    }

    // Build a flat tree config (no hierarchy — original behavior)
    _buildFlatConfig(accounts) {
      const childNodes = accounts.map(a => ({
        id: a.cleanId,
        name: a.label || a.cleanId,
        accountId: a.cleanId,
        unit: "",
        inputEnabled: true,
        childIds: []
      }));

      const rootNode = {
        id: "_auto_root",
        name: "Total",
        unit: "",
        anchor: { type: "calc", symbol: "+" },
        childIds: childNodes.map(n => n.id)
      };

      return { nodes: [rootNode, ...childNodes] };
    }

    // Build a hierarchical tree config from accounts with parentId
    _buildHierarchicalConfig(accounts) {
      // Index accounts by cleanId
      const byId = {};
      accounts.forEach(a => { byId[a.cleanId] = a; });

      // Build child map: parentCleanId → [childCleanIds]
      const childMap = {};
      accounts.forEach(a => {
        if (a.parentCleanId && byId[a.parentCleanId]) {
          if (!childMap[a.parentCleanId]) childMap[a.parentCleanId] = [];
          childMap[a.parentCleanId].push(a.cleanId);
        }
      });

      // Find root(s): accounts with no parentId or whose parent is not in the data
      const roots = accounts.filter(a => !a.parentCleanId || !byId[a.parentCleanId]);

      // Build node configs
      const nodes = [];
      accounts.forEach(a => {
        const children = childMap[a.cleanId] || [];
        const isParent = children.length > 0 || a.isNode;

        const node = {
          id: a.cleanId,
          name: a.label || a.cleanId,
          unit: "",
          childIds: children
        };

        if (isParent) {
          // Calculated/parent node
          node.anchor = { type: "calc", symbol: "+" };
          // Also bind to account so its own value can be read
          node.accountId = a.cleanId;
        } else {
          // Leaf node — data-bound
          node.accountId = a.cleanId;
          node.inputEnabled = true;
        }

        nodes.push(node);
      });

      // If multiple roots, wrap in a synthetic root
      if (roots.length > 1) {
        const syntheticRoot = {
          id: "_auto_root",
          name: "Total",
          unit: "",
          anchor: { type: "calc", symbol: "+" },
          childIds: roots.map(r => r.cleanId)
        };
        nodes.unshift(syntheticRoot);
      }

      return { nodes };
    }

    // ── Zoom & Minimap ──
    _bindZoomEvents() {
      this._shadowRoot.getElementById("zoomIn").addEventListener("click", () => this._setZoom(this._zoomLevel + 0.1));
      this._shadowRoot.getElementById("zoomOut").addEventListener("click", () => this._setZoom(this._zoomLevel - 0.1));
      this._zoomLabel.addEventListener("click", () => this._setZoom(1));
      this._shadowRoot.getElementById("zoomFit").addEventListener("click", () => this._zoomToFit());
      this._shadowRoot.getElementById("minimapToggle").addEventListener("click", () => {
        this._minimapVisible = !this._minimapVisible;
        this._minimap.classList.toggle("vdt-minimap--hidden", !this._minimapVisible);
        if (this._minimapVisible) this._updateMinimap();
      });

      // Mouse wheel zoom (ctrl+scroll)
      this._viewport.addEventListener("wheel", (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          const delta = e.deltaY > 0 ? -0.05 : 0.05;
          this._setZoom(this._zoomLevel + delta);
        }
      }, { passive: false, capture: true });

      // Scroll syncs minimap viewport indicator
      this._viewport.addEventListener("scroll", () => this._updateMinimapViewport());

      // Minimap click to navigate
      this._minimap.addEventListener("mousedown", (e) => {
        if (e.target === this._minimapCanvas || e.target === this._minimapViewportEl) {
          this._minimapNavigate(e);
          const onMove = (me) => this._minimapNavigate(me);
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }
      });
    }

    _setZoom(level) {
      this._zoomLevel = Math.max(0.2, Math.min(2, Math.round(level * 20) / 20));
      this._zoomWrapper.style.transform = `scale(${this._zoomLevel})`;
      this._zoomLabel.textContent = `${Math.round(this._zoomLevel * 100)}%`;
      requestAnimationFrame(() => {
        this._redrawConnectors();
        this._updateMinimap();
      });
    }

    _zoomToFit() {
      const vw = this._viewport.clientWidth - 32;
      const vh = this._viewport.clientHeight - 32;
      // Temporarily reset zoom to measure natural size
      this._zoomWrapper.style.transform = "scale(1)";
      const tw = this._treeRoot.scrollWidth;
      const th = this._treeRoot.scrollHeight;
      if (tw === 0 || th === 0) { this._setZoom(1); return; }
      const fit = Math.min(vw / tw, vh / th, 1);
      this._setZoom(fit);
      this._viewport.scrollLeft = 0;
      this._viewport.scrollTop = 0;
    }

    _updateMinimap() {
      if (!this._minimapVisible || !this._engine.treeData) return;
      const canvas = this._minimapCanvas;
      const ctx = canvas.getContext("2d");
      const mapW = this._minimap.clientWidth;
      const mapH = this._minimap.clientHeight;
      canvas.width = mapW * 2;
      canvas.height = mapH * 2;
      ctx.scale(2, 2);
      ctx.clearRect(0, 0, mapW, mapH);

      // Get tree dimensions at scale 1
      const tw = this._treeRoot.scrollWidth;
      const th = this._treeRoot.scrollHeight;
      if (tw === 0 || th === 0) return;

      const scale = Math.min(mapW / tw, mapH / th) * 0.9;
      const offsetX = (mapW - tw * scale) / 2;
      const offsetY = (mapH - th * scale) / 2;

      // Draw node rectangles from the DOM
      const nodes = this._treeRoot.querySelectorAll(".vdt-node");
      const rootRect = this._treeRoot.getBoundingClientRect();
      const zs = this._zoomLevel;

      ctx.fillStyle = "#e8e8e8";
      ctx.strokeStyle = "#c4c6c8";
      ctx.lineWidth = 0.5;
      nodes.forEach(n => {
        const r = n.getBoundingClientRect();
        const x = offsetX + ((r.left - rootRect.left) / zs) * scale;
        const y = offsetY + ((r.top - rootRect.top) / zs) * scale;
        const w = (r.width / zs) * scale;
        const h = (r.height / zs) * scale;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
      });

      // Draw connectors
      ctx.strokeStyle = "#a0a0a0";
      ctx.lineWidth = 0.5;
      const lines = this._connectorsSvg.querySelectorAll("line");
      lines.forEach(l => {
        const x1 = offsetX + parseFloat(l.getAttribute("x1")) * scale;
        const y1 = offsetY + parseFloat(l.getAttribute("y1")) * scale;
        const x2 = offsetX + parseFloat(l.getAttribute("x2")) * scale;
        const y2 = offsetY + parseFloat(l.getAttribute("y2")) * scale;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      });

      this._minimapScale = scale;
      this._minimapOffsetX = offsetX;
      this._minimapOffsetY = offsetY;
      this._minimapTreeW = tw;
      this._minimapTreeH = th;

      this._updateMinimapViewport();
    }

    _updateMinimapViewport() {
      if (!this._minimapVisible || !this._minimapScale) return;
      const vp = this._viewport;
      const zs = this._zoomLevel;
      const scale = this._minimapScale;

      // Visible area in tree coordinates (unscaled)
      const vx = vp.scrollLeft / zs;
      const vy = vp.scrollTop / zs;
      const vw = vp.clientWidth / zs;
      const vh = vp.clientHeight / zs;

      const el = this._minimapViewportEl;
      el.style.left = (this._minimapOffsetX + vx * scale) + "px";
      el.style.top = (this._minimapOffsetY + vy * scale) + "px";
      el.style.width = Math.min(vw * scale, this._minimap.clientWidth) + "px";
      el.style.height = Math.min(vh * scale, this._minimap.clientHeight) + "px";
    }

    _minimapNavigate(e) {
      const rect = this._minimap.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Convert minimap coords to tree coords
      const tx = (mx - this._minimapOffsetX) / this._minimapScale;
      const ty = (my - this._minimapOffsetY) / this._minimapScale;

      // Scroll so this point is centered
      const zs = this._zoomLevel;
      this._viewport.scrollLeft = tx * zs - this._viewport.clientWidth / 2;
      this._viewport.scrollTop = ty * zs - this._viewport.clientHeight / 2;
    }

    // ── Event Binding ──
    _bindEvents() {
      // Expand/Collapse
      this._shadowRoot.addEventListener("click", e => {
        const toggle = e.target.closest(".vdt-node__toggle");
        if (toggle) {
          const nodeId = toggle.getAttribute("data-node-id");
          const childrenEl = this._shadowRoot.querySelector(`[data-children-of="${nodeId}"]`);
          const gapEl = childrenEl ? childrenEl.previousElementSibling : null;
          if (!childrenEl) return;
          if (childrenEl.style.display === "none") {
            childrenEl.style.display = "flex";
            if (gapEl) gapEl.style.display = "";
            toggle.className = "vdt-node__toggle vdt-node__toggle--expanded";
          } else {
            childrenEl.style.display = "none";
            if (gapEl) gapEl.style.display = "none";
            toggle.className = "vdt-node__toggle vdt-node__toggle--collapsed";
          }
          requestAnimationFrame(() => this._redrawConnectors());
          return;
        }

        // Detail panel toggle
        const detailBtn = e.target.closest(".vdt-node__detail-btn");
        if (detailBtn) {
          const nodeId = detailBtn.getAttribute("data-detail-for");
          const panel = this._shadowRoot.querySelector(`[data-detail-panel="${nodeId}"]`);
          if (panel) {
            panel.classList.toggle("vdt-node__detail-panel--open");
            requestAnimationFrame(() => this._redrawConnectors());
          }
        }
      });

      // Slider — stop SAC from intercepting mouse events on the slider
      this._shadowRoot.addEventListener("mousedown", e => {
        if (e.target.classList.contains("vdt-node__slider")) {
          e.stopPropagation();
        }
      }, true);
      this._shadowRoot.addEventListener("mousemove", e => {
        if (e.target.classList.contains("vdt-node__slider")) {
          e.stopPropagation();
        }
      }, true);
      this._shadowRoot.addEventListener("mouseup", e => {
        if (e.target.classList.contains("vdt-node__slider")) {
          e.stopPropagation();
        }
      }, true);

      // Slider drag — only update percentage label
      this._shadowRoot.addEventListener("input", e => {
        if (!e.target.classList.contains("vdt-node__slider")) return;
        const pct = parseFloat(e.target.value);
        const nodeId = e.target.getAttribute("data-slider-for");
        const pctEl = this._shadowRoot.querySelector(`[data-pct-for="${nodeId}"]`);
        if (pctEl) {
          const sign = pct > 0 ? "+" : "";
          pctEl.textContent = sign + pct.toFixed(1) + "%";
          pctEl.className = "vdt-node__slider-pct" + (pct > 0 ? " vdt-node__slider-pct--positive" : pct < 0 ? " vdt-node__slider-pct--negative" : "");
        }
      });

      // Slider release — compute and update
      this._shadowRoot.addEventListener("change", e => {
        if (e.target.classList.contains("vdt-node__slider")) {
          e.stopPropagation();
          const nodeId = e.target.getAttribute("data-slider-for");
          const pct = parseFloat(e.target.value);
          const node = this._engine.findNode(nodeId);
          if (!node) return;

          node.sliderPct = pct;
          this._engine.recomputeMonthly(node);
          this._engine.recalcParents(this._engine.treeData);
          this._updateAllDisplays(this._engine.treeData);

          if (node.sliderPct !== 0) {
            node.changeLog.push({
              type: "slider",
              description: "Overall adjustment " + (node.sliderPct > 0 ? "+" : "") + node.sliderPct.toFixed(1) + "%",
              pct: node.sliderPct,
              resultValue: node.value,
              timestamp: new Date().toISOString()
            });
            this._publishChanges();
          }
          return;
        }

        // Monthly input
        if (e.target.hasAttribute("data-month-input")) {
          const nodeId = e.target.getAttribute("data-month-input");
          const idx = parseInt(e.target.getAttribute("data-month-idx"));
          const node = this._engine.findNode(nodeId);
          if (!node) return;

          const rawVal = e.target.value.replace(/,/g, "");
          const newVal = parseInt(rawVal);
          if (isNaN(newVal)) { e.target.value = this._renderer.fmt(node.ds1.monthly[idx]); return; }

          const sliderValue = Math.round(node.ds1.monthlyOrig[idx] * (1 + node.sliderPct / 100));
          const prevAdj = node.ds1.monthlyAdj[idx];
          node.ds1.monthlyAdj[idx] = newVal - sliderValue;

          const adjDelta = node.ds1.monthlyAdj[idx] - prevAdj;
          if (Math.abs(adjDelta) >= 1) {
            node.changeLog.push({
              type: "monthly",
              description: MONTHS[idx] + " adjusted by " + (adjDelta > 0 ? "+" : "") + this._renderer.fmt(adjDelta),
              month: idx, delta: adjDelta, resultMonthValue: newVal,
              timestamp: new Date().toISOString()
            });
          }

          this._engine.recomputeMonthly(node);
          this._engine.recalcParents(this._engine.treeData);
          this._updateAllDisplays(this._engine.treeData);
          this._publishChanges();
          requestAnimationFrame(() => this._redrawConnectors());
        }
      });

      // ── On-canvas design mode events ──
      this._shadowRoot.addEventListener("click", e => {
        // Add child "+" button on canvas
        const addBtn = e.target.closest("[data-design-add]");
        if (addBtn) {
          const parentId = addBtn.getAttribute("data-design-add");
          this._showDesignPopup(parentId, "add");
          return;
        }

        // Edit button on canvas
        const editBtn = e.target.closest("[data-design-edit]");
        if (editBtn) {
          const nodeId = editBtn.getAttribute("data-design-edit");
          this._showDesignPopup(nodeId, "edit");
          return;
        }

        // Delete button on canvas
        const delBtn = e.target.closest("[data-design-del]");
        if (delBtn) {
          const nodeId = delBtn.getAttribute("data-design-del");
          this._builderRemoveNode(nodeId);
          this._renderBuilderTree();
          this._applyFullConfig();
          return;
        }

        // Popup OK button
        const okBtn = e.target.closest("[data-design-popup-ok]");
        if (okBtn) {
          this._handleDesignPopupOk(okBtn.getAttribute("data-design-popup-ok"));
          return;
        }

        // Popup cancel button
        const cancelBtn = e.target.closest("[data-design-popup-cancel]");
        if (cancelBtn) {
          this._closeDesignPopups();
          return;
        }
      });
    }

    _showDesignPopup(nodeId, mode) {
      this._closeDesignPopups();
      const wrap = this._shadowRoot.querySelector(`.vdt-node-wrap[data-node-id="${nodeId}"]`);
      if (!wrap) return;
      const popup = wrap.querySelector(".vdt-design-popup");
      if (!popup) return;

      const accounts = this._accountList || [];
      const accountOptions = accounts.map(a =>
        `<option value="${a.cleanId}">${a.label || a.cleanId}</option>`
      ).join("");

      if (mode === "add") {
        popup.innerHTML = `
          <div class="vdt-design-popup__title">Add Child Node</div>
          <div class="vdt-config-field">
            <label>Name</label>
            <input type="text" data-popup-field="name" placeholder="Node name" />
          </div>
          <div class="vdt-config-field">
            <label>Account</label>
            <select data-popup-field="account">
              <option value="">(calculated node)</option>
              ${accountOptions}
            </select>
          </div>
          <div class="vdt-config-field">
            <label>Operator (if calculated)</label>
            <select data-popup-field="operator">
              <option value="+">+ Add</option>
              <option value="\u2212">\u2212 Subtract</option>
              <option value="\u00d7">\u00d7 Multiply</option>
              <option value="\u00f7">\u00f7 Divide</option>
            </select>
          </div>
          <div class="vdt-config-field">
            <label><input type="checkbox" data-popup-field="inputEnabled" checked /> Enable planning slider</label>
          </div>
          <div class="vdt-design-popup__actions">
            <button class="vdt-design-popup__btn vdt-design-popup__btn--ok" data-design-popup-ok="${nodeId}" data-popup-mode="add">Add</button>
            <button class="vdt-design-popup__btn vdt-design-popup__btn--cancel" data-design-popup-cancel>Cancel</button>
          </div>`;
      } else if (mode === "edit") {
        const builderNode = this._builderFindNode(nodeId);
        if (!builderNode) return;
        const isCalc = !builderNode.accountId;
        const currentOp = builderNode.anchor ? builderNode.anchor.symbol : "+";

        popup.innerHTML = `
          <div class="vdt-design-popup__title">Edit Node</div>
          <div class="vdt-config-field">
            <label>Name</label>
            <input type="text" data-popup-field="name" value="${builderNode.name}" />
          </div>
          <div class="vdt-config-field">
            <label>Account</label>
            <select data-popup-field="account">
              <option value="">(calculated node)</option>
              ${accounts.map(a =>
                `<option value="${a.cleanId}" ${a.cleanId === builderNode.accountId ? "selected" : ""}>${a.label || a.cleanId}</option>`
              ).join("")}
            </select>
          </div>
          ${isCalc ? `<div class="vdt-config-field">
            <label>Operator</label>
            <select data-popup-field="operator">
              <option value="+" ${currentOp === "+" ? "selected" : ""}>+ Add</option>
              <option value="\u2212" ${currentOp === "\u2212" ? "selected" : ""}>\u2212 Subtract</option>
              <option value="\u00d7" ${currentOp === "\u00d7" ? "selected" : ""}>\u00d7 Multiply</option>
              <option value="\u00f7" ${currentOp === "\u00f7" ? "selected" : ""}>\u00f7 Divide</option>
            </select>
          </div>` : ""}
          <div class="vdt-config-field">
            <label><input type="checkbox" data-popup-field="inputEnabled" ${builderNode.inputEnabled ? "checked" : ""} /> Enable planning slider</label>
          </div>
          <div class="vdt-design-popup__actions">
            <button class="vdt-design-popup__btn vdt-design-popup__btn--ok" data-design-popup-ok="${nodeId}" data-popup-mode="edit">Save</button>
            <button class="vdt-design-popup__btn vdt-design-popup__btn--cancel" data-design-popup-cancel>Cancel</button>
          </div>`;
      }

      popup.classList.add("vdt-design-popup--open");
    }

    _closeDesignPopups() {
      this._shadowRoot.querySelectorAll(".vdt-design-popup--open").forEach(p => {
        p.classList.remove("vdt-design-popup--open");
      });
    }

    _handleDesignPopupOk(nodeId) {
      const wrap = this._shadowRoot.querySelector(`.vdt-node-wrap[data-node-id="${nodeId}"]`);
      if (!wrap) return;
      const popup = wrap.querySelector(".vdt-design-popup");
      if (!popup) return;

      const mode = popup.querySelector("[data-design-popup-ok]").getAttribute("data-popup-mode");
      const name = (popup.querySelector("[data-popup-field='name']").value || "").trim();
      const accountId = popup.querySelector("[data-popup-field='account']").value || null;
      const opEl = popup.querySelector("[data-popup-field='operator']");
      const op = opEl ? opEl.value : "+";
      const inputEl = popup.querySelector("[data-popup-field='inputEnabled']");
      const inputEnabled = inputEl ? inputEl.checked : true;

      if (!name) return;

      if (mode === "add") {
        const child = {
          id: this._builderGenerateId(name),
          name: name,
          accountId: accountId,
          inputEnabled: accountId ? inputEnabled : false,
          childIds: []
        };
        if (!accountId) {
          child.anchor = { type: "calc", symbol: op };
        }

        // Add to parent's children
        const parent = this._builderFindNode(nodeId);
        if (parent) {
          parent.childIds = parent.childIds || [];
          parent.childIds.push(child.id);
          // Ensure parent is a calculated node if it wasn't already
          if (!parent.anchor && !parent.accountId) {
            parent.anchor = { type: "calc", symbol: "+" };
          }
        }
        this._builderNodes.push(child);

      } else if (mode === "edit") {
        const node = this._builderFindNode(nodeId);
        if (!node) return;
        node.name = name;
        node.accountId = accountId;
        node.inputEnabled = inputEnabled;
        if (!accountId && opEl) {
          node.anchor = { type: "calc", symbol: op };
        } else if (accountId) {
          node.anchor = null;
        }
      }

      this._closeDesignPopups();
      this._renderBuilderTree();
      this._applyFullConfig();
    }

    // Lightweight: only update value text during slider drag (no DOM structure changes)
    _updateValueDisplaysOnly(node) {
      if (!node) return;
      const wrap = this._shadowRoot.querySelector(`.vdt-node-wrap[data-node-id="${node.id}"]`);
      if (wrap) {
        const valEl = wrap.querySelector(".vdt-node__value");
        if (valEl) valEl.textContent = this._renderer.fmt(node.value);
      }
      if (node.children) node.children.forEach(c => this._updateValueDisplaysOnly(c));
    }

    _updateAllDisplays(node) {
      if (!node) return;
      const wrap = this._shadowRoot.querySelector(`.vdt-node-wrap[data-node-id="${node.id}"]`);
      if (!wrap) return;

      // Value
      const valEl = wrap.querySelector(".vdt-node__value");
      if (valEl) valEl.textContent = this._renderer.fmt(node.value);

      // Impact badge
      let badge = wrap.querySelector(".vdt-node__impact");
      const pct = this._renderer.impactPct(node);
      if (Math.abs(pct) > 0.05) {
        const sign = pct > 0 ? "+" : "";
        const cls = pct > 0 ? "positive" : "negative";
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "vdt-node__impact vdt-node__impact--" + cls;
          const nameEl = wrap.querySelector(".vdt-node__measure-name");
          nameEl.insertAdjacentElement("afterend", badge);
        }
        badge.textContent = sign + pct.toFixed(1) + "%";
        badge.className = "vdt-node__impact vdt-node__impact--" + cls;
      } else if (badge) {
        badge.remove();
      }

      // Display rows
      const rowEls = wrap.querySelectorAll(".vdt-node__value-row");
      (node.displayRows || []).forEach((row, i) => {
        if (!rowEls[i]) return;
        const valSpan = rowEls[i].querySelector(".vdt-node__row-value");
        if (valSpan) valSpan.textContent = this._renderer.fmt(row.value) + " " + node.unit;
        // Update variance if paired
        const varSpan = rowEls[i].querySelector(".vdt-node__variance");
        const pairRow = node.displayRows.find((r, j) =>
          j !== i && r.dataSet !== row.dataSet && r.timeVariant === row.timeVariant
        );
        if (varSpan && pairRow) {
          const v = this._renderer.computeVariance(row.value, pairRow.value, node.unit);
          varSpan.className = "vdt-node__variance vdt-node__variance--" + v.dir;
          varSpan.innerHTML = `<span class="vdt-node__variance-arrow">${v.arrow}</span><span>${v.varDisplay}</span><span>(${v.pctDisplay})</span>`;
        }
      });

      // Detail panel
      if (node.inputEnabled) this._updateDetailPanel(node);

      if (node.children) node.children.forEach(c => this._updateAllDisplays(c));
    }

    _updateDetailPanel(node) {
      const inputs = this._shadowRoot.querySelectorAll(`[data-month-input="${node.id}"]`);
      const deltas = this._shadowRoot.querySelectorAll(`[data-month-delta="${node.id}"]`);
      const totalEl = this._shadowRoot.querySelector(`[data-detail-total="${node.id}"]`);

      inputs.forEach(inp => {
        const idx = parseInt(inp.getAttribute("data-month-idx"));
        if (this._shadowRoot.activeElement !== inp) inp.value = this._renderer.fmt(node.ds1.monthly[idx]);
      });

      deltas.forEach(del => {
        const idx = parseInt(del.getAttribute("data-month-idx"));
        const diff = node.ds1.monthly[idx] - node.ds1.monthlyOrig[idx];
        if (Math.abs(diff) < 1) {
          del.textContent = "-";
          del.className = "vdt-node__detail-month-delta vdt-node__detail-month-delta--neutral";
        } else {
          del.textContent = (diff > 0 ? "+" : "") + this._renderer.fmt(diff);
          del.className = "vdt-node__detail-month-delta vdt-node__detail-month-delta--" + (diff > 0 ? "positive" : "negative");
        }
      });

      if (totalEl) totalEl.textContent = "Total: " + this._renderer.fmt(node.value) + " " + node.unit;
    }

    _publishChanges() {
      const result = this._engine.getChangedValues();
      const entries = result.writeBackEntries || [];
      const ctx = result.planningContext || {};

      // Build pipe-delimited arrays for SAC scripting (no JSON.parse needed)
      // Use full SAC member IDs — setUserInput requires these, not short IDs
      const accounts = entries.map(e => e.accountSacId).join("|");
      const times = entries.map(e => e.timeMemberId).join("|");
      const values = entries.map(e => String(Math.round(e.newValue))).join("|");

      const props = {
        changedValues: JSON.stringify(result),
        _writeBackCount: entries.length,
        _writeBackAccounts: accounts,
        _writeBackTimes: times,
        _writeBackValues: values,
        _writeBackVersion: ctx.version || "",
        _writeBackMeasureDim: ctx.measureDimValue || "",
        _writeBackAccountDim: ctx.accountDimension || "",
        _writeBackVersionDim: ctx.versionDimension || "",
        _writeBackTimeDim: ctx.timeDimension || ""
      };

      // Store directly on instance (for console debugging + direct access)
      Object.assign(this, props);
      console.log("VDT: _publishChanges —", entries.length, "entries", { accounts, times, values, ctx });

      // Update SAC properties
      this.dispatchEvent(new CustomEvent("propertiesChanged", {
        detail: { properties: props }
      }));

      // Fire the planning event
      this.dispatchEvent(new Event("onSubmitPlanning"));
    }
  }

  customElements.define("com-custom-vdt-main", ValueDriverTreeWidget);
})();
