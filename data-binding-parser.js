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
