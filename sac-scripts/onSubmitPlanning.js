// ============================================================
// SAC Script: VDT_1.onSubmitPlanning event handler
// ============================================================
// Paste this into SAC Story > VDT_1 widget > onSubmitPlanning event
//
// Prerequisites:
//   - Table_1 must be a planning-enabled Table on the same page
//   - Table_1's data source must have planning write-back enabled
//   - VDT_1 is the Value Driver Tree custom widget
//
// How it works:
//   The widget passes plain time member IDs (e.g. "2017", "201701").
//   This script resolves them to full SAC member IDs using
//   ds.getMembers() — which returns the exact format setUserInput
//   expects, including hierarchy level names for parent members.
//
//   Leaf (month):  [Time].[YM].&[201701]
//   Parent (year): [Time].[YM].[Time.YEAR].[2017]
//
//   This avoids hardcoding level names and works across any
//   time hierarchy (YM, YQM, YHQM, etc.).
// ============================================================

var count = VDT_1.getWriteBackCount();
if (count === 0) {
    return;
}

var timeDim    = VDT_1.getWriteBackTimeDim();
var accountDim = VDT_1.getWriteBackAccountDim();
var versionDim = VDT_1.getWriteBackVersionDim();
var version    = VDT_1.getWriteBackVersion();
var measureVal = VDT_1.getWriteBackMeasureDim();

console.log("VDT: starting write-back");
console.log("VDT: timeDim=" + timeDim + " accountDim=" + accountDim + " versionDim=" + versionDim);
console.log("VDT: version=" + version + " measure=" + measureVal);

// Step 1: Get time members from data source (typed SAC array)
// getMembers() returns full SAC IDs that setUserInput expects
var ds = Table_1.getDataSource();
var members = ds.getMembers(timeDim);

console.log("VDT: got members");

// Step 2: Write back each entry
var planning = Table_1.getPlanning();

for (var i = 0; i < count; i = i + 1) {
    var account  = VDT_1.getWriteBackAccount(i);
    var rawTime  = VDT_1.getWriteBackTime(i);
    var valueStr = VDT_1.getWriteBackValue(i);

    // Scan members to find the full SAC ID matching this plain time ID
    // Extracts plain ID from last bracket group and compares
    var fullTimeId = "";
    for (var j = 0; j < members.length; j = j + 1) {
        var memId = members[j].id;
        var lastOpen  = memId.lastIndexOf("[");
        var lastClose = memId.lastIndexOf("]");
        if (lastOpen >= 0 && lastClose > lastOpen) {
            var extracted = memId.substring(lastOpen + 1, lastClose);
            if (extracted === rawTime) {
                fullTimeId = memId;
            }
        }
    }

    console.log("VDT entry: time=" + rawTime + " resolved=" + fullTimeId + " account=" + account + " value=" + valueStr);

    if (fullTimeId === "") {
        console.log("VDT SKIP: no lookup for time=" + rawTime);
    } else {
        var sel = {};
        sel[accountDim]          = account;
        sel[versionDim]          = version;
        sel[timeDim]             = fullTimeId;
        sel["@MeasureDimension"] = measureVal;

        planning.setUserInput(sel, valueStr);
    }
}

planning.submitData();
console.log("VDT: submitData called");
