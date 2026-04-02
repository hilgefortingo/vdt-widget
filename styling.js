(function () {
  const template = document.createElement("template");
  template.innerHTML = `
    <style>
      :host { font-family: "72", Arial, Helvetica, sans-serif; display: block; padding: 12px; }
      *, *::before, *::after { box-sizing: border-box; }

      .section { margin-bottom: 20px; }
      .section-title {
        font-size: 11px; font-weight: 700; color: #32363a; margin-bottom: 10px;
        text-transform: uppercase; letter-spacing: 0.4px;
        padding-bottom: 6px; border-bottom: 1px solid #eee;
      }
      .field { margin-bottom: 10px; }
      .field label { display: block; font-size: 11px; font-weight: 600; color: #6a6d70; margin-bottom: 4px; }
      .field input, .field select {
        width: 100%; font-family: "72", Arial, sans-serif; font-size: 12px;
        padding: 6px 8px; border: 1px solid #d9d9d9; border-radius: 4px; outline: none; box-sizing: border-box;
        background: #fff; color: #32363a;
      }
      .field input:focus, .field select:focus { border-color: #0a6ed1; box-shadow: 0 0 0 2px rgba(10,110,209,0.15); }
      .field select { -webkit-appearance: auto; appearance: auto; }
      .row { display: flex; gap: 8px; }
      .row .field { flex: 1; }

      .hint { font-size: 10px; color: #89919a; margin-top: 3px; line-height: 1.4; }
      .status { font-size: 10px; padding: 4px 8px; border-radius: 3px; margin-top: 4px; }
      .status--ok { background: #e8f5e9; color: #107e3e; }
      .status--warn { background: #fff3e0; color: #e9730c; }

      .btn {
        font-family: "72", Arial, sans-serif; font-size: 12px; font-weight: 600;
        padding: 7px 16px; border: none; border-radius: 4px; cursor: pointer;
      }
      .btn--primary { background: #0a6ed1; color: #fff; }
      .btn--primary:hover { background: #085cad; }
      .btn--secondary { background: #fff; color: #32363a; border: 1px solid #d9d9d9; }
      .btn--secondary:hover { background: #f5f6f7; }
      .actions { display: flex; gap: 8px; margin-top: 16px; }
    </style>

    <!-- Section 1: Info -->
    <div class="section">
      <div class="section-title">Data Binding</div>
      <div class="hint" style="margin-bottom:8px; padding: 6px 8px; background: #e3f2fd; border-radius: 4px; color: #0a6ed1;">
        Dimension mapping, version selection, and tree structure are configured in the <strong>main widget</strong> (click the &#9881; gear icon on the widget in design mode).
      </div>

      <div class="field">
        <label>Time Granularity</label>
        <select id="timeGranularity">
          <option value="month">Monthly</option>
          <option value="quarter">Quarterly</option>
          <option value="year">Yearly</option>
        </select>
      </div>
    </div>

    <!-- Section 2: Comparison Periods -->
    <div class="section">
      <div class="section-title">Comparison Periods</div>
      <div class="hint" style="margin-bottom:8px;">Define up to 3 comparison periods. Each will show the reference value and variance in the node tiles.</div>

      <div class="field">
        <label>Comparison 1</label>
        <div class="row">
          <div class="field" style="flex:1;">
            <input type="text" id="comp1Label" placeholder="Label (e.g., PY)" />
          </div>
          <div class="field" style="flex:2;">
            <select id="comp1Type">
              <option value="py">Previous Year</option>
              <option value="pm">Previous Month</option>
              <option value="pq">Previous Quarter</option>
              <option value="version">Different Version</option>
              <option value="custom">Custom Period</option>
            </select>
          </div>
        </div>
      </div>

      <div class="field">
        <label>Comparison 2</label>
        <div class="row">
          <div class="field" style="flex:1;">
            <input type="text" id="comp2Label" placeholder="Label (e.g., Month PY)" />
          </div>
          <div class="field" style="flex:2;">
            <select id="comp2Type">
              <option value="">Not used</option>
              <option value="py">Previous Year</option>
              <option value="pm">Previous Month</option>
              <option value="pq">Previous Quarter</option>
              <option value="version">Different Version</option>
              <option value="custom">Custom Period</option>
            </select>
          </div>
        </div>
      </div>

      <div class="field">
        <label>Comparison 3</label>
        <div class="row">
          <div class="field" style="flex:1;">
            <input type="text" id="comp3Label" placeholder="Label (optional)" />
          </div>
          <div class="field" style="flex:2;">
            <select id="comp3Type">
              <option value="">Not used</option>
              <option value="py">Previous Year</option>
              <option value="pm">Previous Month</option>
              <option value="pq">Previous Quarter</option>
              <option value="version">Different Version</option>
              <option value="custom">Custom Period</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <!-- Section 3: Thresholds -->
    <div class="section">
      <div class="section-title">Threshold Indicators</div>
      <div class="hint" style="margin-bottom:8px;">Color-coded bar on the left edge of each node based on variance percentage.</div>
      <div class="row">
        <div class="field">
          <label style="color:#107e3e;">Positive &ge;</label>
          <input type="number" id="threshPositive" value="5" /> <span class="hint">%</span>
        </div>
        <div class="field">
          <label style="color:#e9730c;">Warning &ge;</label>
          <input type="number" id="threshWarning" value="0" /> <span class="hint">%</span>
        </div>
        <div class="field">
          <label style="color:#bb0000;">Negative &lt;</label>
          <input type="number" id="threshNegative" value="-5" /> <span class="hint">%</span>
        </div>
      </div>
    </div>

    <!-- Section 4: Planning Input -->
    <div class="section">
      <div class="section-title">Planning Input</div>
      <div class="row">
        <div class="field">
          <label>Slider Min (%)</label>
          <input type="number" id="sliderMin" value="-25" />
        </div>
        <div class="field">
          <label>Slider Max (%)</label>
          <input type="number" id="sliderMax" value="25" />
        </div>
      </div>
    </div>

    <!-- Section 5: Display -->
    <div class="section">
      <div class="section-title">Display Options</div>
      <div class="field">
        <label>Node Width (px)</label>
        <input type="number" id="nodeWidth" value="400" />
      </div>
      <div class="field">
        <label>Number Format</label>
        <select id="numberFormat">
          <option value="en-US">1,234,567 (English)</option>
          <option value="de-DE">1.234.567 (German)</option>
          <option value="fr-FR">1 234 567 (French)</option>
        </select>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn--primary" id="applyBtn">Apply</button>
    </div>
  `;

  class ValueDriverTreeStyling extends HTMLElement {
    constructor() {
      super();
      this._shadowRoot = this.attachShadow({ mode: "open" });
      this._shadowRoot.appendChild(template.content.cloneNode(true));
      this._shadowRoot.getElementById("applyBtn").addEventListener("click", () => {
        this._apply();
      });
    }

    // Called by SAC when properties or data change
    onCustomWidgetAfterUpdate(changedProperties) {
      // Sync field values from saved properties
      this._syncField("timeGranularity", changedProperties.timeGranularity);
      this._syncField("comp1Label", changedProperties.comparisonPeriod1Label);
      this._syncField("comp2Label", changedProperties.comparisonPeriod2Label);
      this._syncField("comp3Label", changedProperties.comparisonPeriod3Label);
      this._syncField("comp1Type", changedProperties.comparison1Type);
      this._syncField("comp2Type", changedProperties.comparison2Type);
      this._syncField("comp3Type", changedProperties.comparison3Type);
      this._syncField("threshPositive", changedProperties.thresholdPositive);
      this._syncField("threshWarning", changedProperties.thresholdWarning);
      this._syncField("threshNegative", changedProperties.thresholdNegative);
      this._syncField("sliderMin", changedProperties.sliderMin);
      this._syncField("sliderMax", changedProperties.sliderMax);
      this._syncField("nodeWidth", changedProperties.nodeWidth);
      this._syncField("numberFormat", changedProperties.numberFormat);
    }

    _syncField(elementId, value) {
      if (value !== undefined) {
        const el = this._shadowRoot.getElementById(elementId);
        if (el) el.value = value;
      }
    }

    _apply() {
      const properties = {
        timeGranularity: this._shadowRoot.getElementById("timeGranularity").value,
        comparisonPeriod1Label: this._shadowRoot.getElementById("comp1Label").value,
        comparisonPeriod2Label: this._shadowRoot.getElementById("comp2Label").value,
        comparisonPeriod3Label: this._shadowRoot.getElementById("comp3Label").value,
        comparison1Type: this._shadowRoot.getElementById("comp1Type").value,
        comparison2Type: this._shadowRoot.getElementById("comp2Type").value,
        comparison3Type: this._shadowRoot.getElementById("comp3Type").value,
        thresholdPositive: parseFloat(this._shadowRoot.getElementById("threshPositive").value) || 5,
        thresholdWarning: parseFloat(this._shadowRoot.getElementById("threshWarning").value) || 0,
        thresholdNegative: parseFloat(this._shadowRoot.getElementById("threshNegative").value) || -5,
        sliderMin: parseFloat(this._shadowRoot.getElementById("sliderMin").value) || -25,
        sliderMax: parseFloat(this._shadowRoot.getElementById("sliderMax").value) || 25,
        nodeWidth: parseInt(this._shadowRoot.getElementById("nodeWidth").value) || 400,
        numberFormat: this._shadowRoot.getElementById("numberFormat").value
      };

      this.dispatchEvent(new CustomEvent("propertiesChanged", {
        detail: { properties }
      }));
    }
  }

  customElements.define("com-custom-vdt-styling", ValueDriverTreeStyling);
})();
