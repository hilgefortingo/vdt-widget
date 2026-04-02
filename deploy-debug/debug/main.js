(function () {
  const template = document.createElement("template");
  template.innerHTML = `
    <style>
      :host {
        display: block;
        width: 100%;
        height: 100%;
        font-family: "72", Arial, Helvetica, sans-serif;
      }
      .debug-root {
        width: 100%;
        height: 100%;
        overflow: auto;
        background: #fff;
        padding: 16px;
        box-sizing: border-box;
      }
      .debug-header {
        font-size: 14px;
        font-weight: 700;
        color: #32363a;
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 2px solid #0a6ed1;
      }
      .debug-status {
        font-size: 12px;
        padding: 8px 12px;
        border-radius: 4px;
        margin-bottom: 12px;
      }
      .debug-status--waiting { background: #fff3e0; color: #e9730c; }
      .debug-status--success { background: #e8f5e9; color: #107e3e; }
      .debug-status--error { background: #fce4ec; color: #bb0000; }
      .debug-section {
        margin-bottom: 16px;
      }
      .debug-section-title {
        font-size: 11px;
        font-weight: 700;
        color: #6a6d70;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        margin-bottom: 6px;
      }
      .debug-pre {
        font-family: "Courier New", monospace;
        font-size: 11px;
        background: #f5f6f7;
        border: 1px solid #e8e8e8;
        border-radius: 4px;
        padding: 10px;
        overflow: auto;
        max-height: 300px;
        white-space: pre-wrap;
        word-break: break-all;
      }
      .debug-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 11px;
      }
      .debug-table th {
        text-align: left;
        padding: 4px 8px;
        background: #fafafa;
        border-bottom: 1px solid #ddd;
        font-weight: 600;
        color: #6a6d70;
      }
      .debug-table td {
        padding: 4px 8px;
        border-bottom: 1px solid #f0f0f0;
      }
      .debug-btn {
        font-family: "72", Arial, sans-serif;
        font-size: 11px;
        font-weight: 600;
        padding: 4px 10px;
        border: 1px solid #d9d9d9;
        border-radius: 3px;
        background: #fff;
        cursor: pointer;
        color: #32363a;
        margin-right: 4px;
      }
      .debug-btn:hover { background: #f5f6f7; }
      .debug-btn--primary { background: #0a6ed1; color: #fff; border-color: #0a6ed1; }
      .debug-count {
        font-size: 12px;
        color: #32363a;
        margin-bottom: 8px;
      }
      .debug-count strong { color: #0a6ed1; }
    </style>
    <div class="debug-root">
      <div class="debug-header">VDT Debug Widget — Data Binding Inspector</div>
      <div class="debug-status debug-status--waiting" id="status">Waiting for data binding...</div>

      <div class="debug-section">
        <div class="debug-section-title">Actions</div>
        <button class="debug-btn debug-btn--primary" id="btnCopy">Copy Full JSON to Clipboard</button>
        <button class="debug-btn" id="btnCopyMeta">Copy Metadata Only</button>
        <button class="debug-btn" id="btnCopyFirst10">Copy First 10 Rows</button>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">Binding State</div>
        <div class="debug-pre" id="stateInfo">-</div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">Metadata — Dimensions</div>
        <div class="debug-pre" id="metaDims">-</div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">Metadata — Measures</div>
        <div class="debug-pre" id="metaMeasures">-</div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">Metadata — Feeds</div>
        <div class="debug-pre" id="metaFeeds">-</div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">Data Rows</div>
        <div class="debug-count" id="rowCount">-</div>
        <div id="dataRows">-</div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">First Row — Full Structure</div>
        <div class="debug-pre" id="firstRow">-</div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">Unique Dimension Members</div>
        <div id="uniqueMembers">-</div>
      </div>

      <div class="debug-section">
        <div class="debug-section-title">Raw dataBinding Object Keys</div>
        <div class="debug-pre" id="rawKeys">-</div>
      </div>
    </div>
  `;

  class VDTDebugWidget extends HTMLElement {
    constructor() {
      super();
      this._shadowRoot = this.attachShadow({ mode: "open" });
      this._shadowRoot.appendChild(template.content.cloneNode(true));
      this._lastDataBinding = null;

      // Copy buttons
      this._shadowRoot.getElementById("btnCopy").addEventListener("click", () => this._copyToClipboard("full"));
      this._shadowRoot.getElementById("btnCopyMeta").addEventListener("click", () => this._copyToClipboard("meta"));
      this._shadowRoot.getElementById("btnCopyFirst10").addEventListener("click", () => this._copyToClipboard("first10"));
    }

    // SAC lifecycle
    onCustomWidgetBeforeUpdate(changedProperties) {}

    onCustomWidgetAfterUpdate(changedProperties) {
      this._processDataBinding();
    }

    onCustomWidgetResize(width, height) {}
    onCustomWidgetDestroy() {}

    // Data binding setter — SAC delivers data here
    set dataBinding(value) {
      this._lastDataBinding = value;
      console.log("=== VDT DEBUG: dataBinding received ===");
      console.log("Type:", typeof value);
      console.log("Value:", value);
      try {
        console.log("JSON:", JSON.stringify(value).substring(0, 2000));
      } catch (e) {
        console.log("Could not stringify:", e.message);
      }
      this._processDataBinding();
    }

    get dataBinding() {
      return this._lastDataBinding;
    }

    _processDataBinding() {
      const db = this._lastDataBinding;
      if (!db) return;

      const statusEl = this._shadowRoot.getElementById("status");
      const stateEl = this._shadowRoot.getElementById("stateInfo");
      const metaDimsEl = this._shadowRoot.getElementById("metaDims");
      const metaMeasuresEl = this._shadowRoot.getElementById("metaMeasures");
      const metaFeedsEl = this._shadowRoot.getElementById("metaFeeds");
      const rowCountEl = this._shadowRoot.getElementById("rowCount");
      const dataRowsEl = this._shadowRoot.getElementById("dataRows");
      const firstRowEl = this._shadowRoot.getElementById("firstRow");
      const uniqueMembersEl = this._shadowRoot.getElementById("uniqueMembers");
      const rawKeysEl = this._shadowRoot.getElementById("rawKeys");

      // State
      stateEl.textContent = "state: " + (db.state || "(no state property)");
      if (db.state === "success") {
        statusEl.className = "debug-status debug-status--success";
        statusEl.textContent = "Data binding active — state: success";
      } else {
        statusEl.className = "debug-status debug-status--error";
        statusEl.textContent = "Data binding state: " + (db.state || "unknown");
      }

      // Raw keys
      rawKeysEl.textContent = "Top-level keys: " + Object.keys(db).join(", ") + "\n\n";
      if (db.metadata) {
        rawKeysEl.textContent += "metadata keys: " + Object.keys(db.metadata).join(", ") + "\n";
        if (db.metadata.feeds) rawKeysEl.textContent += "metadata.feeds keys: " + Object.keys(db.metadata.feeds).join(", ") + "\n";
        if (db.metadata.dimensions) rawKeysEl.textContent += "metadata.dimensions keys: " + Object.keys(db.metadata.dimensions).join(", ") + "\n";
        if (db.metadata.mainStructureMembers) rawKeysEl.textContent += "metadata.mainStructureMembers keys: " + Object.keys(db.metadata.mainStructureMembers).join(", ") + "\n";
      }

      // Metadata — Dimensions
      if (db.metadata && db.metadata.dimensions) {
        metaDimsEl.textContent = JSON.stringify(db.metadata.dimensions, null, 2);
      } else {
        metaDimsEl.textContent = "(no metadata.dimensions)";
      }

      // Metadata — Measures
      if (db.metadata && db.metadata.mainStructureMembers) {
        metaMeasuresEl.textContent = JSON.stringify(db.metadata.mainStructureMembers, null, 2);
      } else {
        metaMeasuresEl.textContent = "(no metadata.mainStructureMembers)";
      }

      // Metadata — Feeds
      if (db.metadata && db.metadata.feeds) {
        metaFeedsEl.textContent = JSON.stringify(db.metadata.feeds, null, 2);
      } else {
        metaFeedsEl.textContent = "(no metadata.feeds)";
      }

      // Data rows
      if (db.data && Array.isArray(db.data)) {
        rowCountEl.innerHTML = "Total rows: <strong>" + db.data.length + "</strong>";

        if (db.data.length === 0) {
          firstRowEl.textContent = "(data array is empty)";
          dataRowsEl.textContent = "(no rows)";
          uniqueMembersEl.textContent = "(no rows to inspect)";
          return;
        }

        const firstRow = db.data[0];
        if (!firstRow || typeof firstRow !== 'object') {
          firstRowEl.textContent = "(first row is null or not an object)";
          dataRowsEl.textContent = "(invalid row format)";
          uniqueMembersEl.textContent = "(no valid rows)";
          return;
        }

        // First row full structure
        firstRowEl.textContent = JSON.stringify(firstRow, null, 2);

        // Build data table for first 20 rows
        const keys = Object.keys(firstRow);
        let html = '<table class="debug-table"><thead><tr>';
        keys.forEach(k => { html += '<th>' + k + '</th>'; });
        html += '</tr></thead><tbody>';

        db.data.slice(0, 20).forEach(row => {
          if (!row || typeof row !== 'object') { html += '<tr><td colspan="' + keys.length + '">(null row)</td></tr>'; return; }
          html += '<tr>';
          keys.forEach(k => {
            const val = row[k];
            if (val && typeof val === 'object') {
              if (val.raw !== undefined) {
                html += '<td>' + (val.formatted || val.raw) + ' ' + (val.unit || '') + '</td>';
              } else {
                html += '<td>' + (val.label || val.id || JSON.stringify(val)) + (val.parentId ? ' [parent:' + val.parentId + ']' : '') + '</td>';
              }
            } else {
              html += '<td>' + (val !== undefined ? val : '-') + '</td>';
            }
          });
          html += '</tr>';
        });
        html += '</tbody></table>';
        if (db.data.length > 20) html += '<div style="font-size:10px; color:#89919a; margin-top:4px;">Showing first 20 of ' + db.data.length + ' rows</div>';
        dataRowsEl.innerHTML = html;

        // Unique members per dimension
        const dimKeys = keys.filter(k => {
          const v = firstRow[k];
          return v && typeof v === 'object' && v.id !== undefined && v.raw === undefined;
        });

        let membersHtml = '';
        dimKeys.forEach(dimKey => {
          const dimInfo = (db.metadata && db.metadata.dimensions && db.metadata.dimensions[dimKey]) || {};
          const seen = {};
          const members = [];
          db.data.forEach(row => {
            if (!row) return;
            const m = row[dimKey];
            if (m && m.id && !seen[m.id]) {
              seen[m.id] = true;
              members.push(m);
            }
          });

          membersHtml += '<div class="debug-section-title" style="margin-top:8px;">' + (dimInfo.description || dimInfo.id || dimKey) + ' (' + members.length + ' members)</div>';
          membersHtml += '<div class="debug-pre" style="max-height:150px;">';
          members.forEach(m => {
            membersHtml += (m.id || '(no id)') + ' — ' + (m.label || '(no label)');
            if (m.parentId) membersHtml += '  →  parent: ' + m.parentId;
            const extraKeys = Object.keys(m).filter(k => k !== 'id' && k !== 'label' && k !== 'parentId');
            if (extraKeys.length > 0) {
              membersHtml += '  {' + extraKeys.map(k => k + ':' + JSON.stringify(m[k])).join(', ') + '}';
            }
            membersHtml += '\n';
          });
          membersHtml += '</div>';
        });

        uniqueMembersEl.innerHTML = membersHtml;

      } else {
        rowCountEl.textContent = "No data array found";
        dataRowsEl.textContent = "(no data)";
        firstRowEl.textContent = "(no data)";
        uniqueMembersEl.textContent = "(no data)";
      }
    }

    _copyToClipboard(mode) {
      const db = this._lastDataBinding;
      if (!db) { alert("No data binding received yet"); return; }

      let text = "";
      try {
        if (mode === "full") {
          text = JSON.stringify(db, null, 2);
        } else if (mode === "meta") {
          text = JSON.stringify({ state: db.state, metadata: db.metadata, dataRowCount: db.data ? db.data.length : 0 }, null, 2);
        } else if (mode === "first10") {
          text = JSON.stringify({ state: db.state, metadata: db.metadata, data: (db.data || []).slice(0, 10) }, null, 2);
        }
      } catch (e) {
        text = "Error serializing: " + e.message;
      }

      navigator.clipboard.writeText(text).then(() => {
        alert("Copied to clipboard (" + text.length + " characters)");
      }).catch(() => {
        // Fallback
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        alert("Copied to clipboard (" + text.length + " characters)");
      });
    }
  }

  customElements.define("com-custom-vdt-debug", VDTDebugWidget);
})();
