/**
 * MSC Recruiting Board: Google Apps Script for the recruiting Sheet.
 *
 * Paste this file and Dashboard.html into the Sheet's script editor
 * (Extensions > Apps Script). It adds a "Recruiting" menu that opens the
 * ranked dashboard. Only people the Sheet is shared with can open it.
 *
 * The Sheet holds the data:
 *   Players  one row per player (Claude's weekly update and staff edits)
 *   Updates  a log of each weekly update
 */

var PLAYERS_TAB = 'Players';
var UPDATES_TAB = 'Updates';
var UPDATES_HEADER = ['Date', 'Type', 'Added', 'Updated', 'Status changes', 'Notes'];

// Runs when the Sheet opens. (Running it from the script editor fails
// with "Cannot call SpreadsheetApp.getUi() from this context"; use setup.)
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Recruiting')
      .addItem('Open dashboard', 'openDashboard')
      .addToUi();
  } catch (e) {
    // No UI when run from the editor or a trigger.
  }
  ensureTabs_();
}

// Run this once from the script editor (pick "setup" next to Run). It sets
// up the tabs, asks for permissions, and checks the Dashboard file.
function setup() {
  ensureTabs_();
  HtmlService.createHtmlOutputFromFile('Dashboard'); // throws if the file is missing
  var rows = getBoardData().rows.length - 1;
  Logger.log('Setup OK: ' + rows + ' player rows found. Reload the Sheet and use Recruiting > Open dashboard.');
}

function openDashboard() {
  var html;
  try {
    html = HtmlService.createHtmlOutputFromFile('Dashboard');
  } catch (e) {
    SpreadsheetApp.getUi().alert('No HTML file named "Dashboard" was found. In Extensions > Apps Script, add an HTML file named Dashboard and paste in Dashboard.html.');
    return;
  }
  SpreadsheetApp.getUi().showModalDialog(html.setWidth(1400).setHeight(850), 'Recruiting Board');
}

// Optional: Deploy > New deployment > Web app gives a full-page dashboard.
// Set "Who has access" to "Only myself" (or your school's domain), because
// the page shows every row of the Sheet.
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('Recruiting Board')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Called by the dashboard page. Returns displayed cell text, so dates and
// numbers arrive exactly as the Sheet shows them.
function getBoardData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  var players = ss.getSheetByName(PLAYERS_TAB) || ss.getSheets()[0];
  var rows = players.getDataRange().getDisplayValues();

  var lastUpdate = '';
  var updates = ss.getSheetByName(UPDATES_TAB);
  if (updates && updates.getLastRow() > 1) {
    var last = updates.getRange(updates.getLastRow(), 1, 1, UPDATES_HEADER.length).getDisplayValues()[0];
    lastUpdate = 'Last update ' + last[0] + ': ' + last[2] + ' added, ' + last[3] + ' updated, ' + last[4] + ' status changes';
  }
  return { rows: rows, programName: ss.getName().replace(/ Recruiting Board$/, ''), lastUpdate: lastUpdate };
}

function ensureTabs_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) return;
  if (!ss.getSheetByName(PLAYERS_TAB) && ss.getSheets().length === 1) ss.getSheets()[0].setName(PLAYERS_TAB);
  if (!ss.getSheetByName(UPDATES_TAB)) {
    var tab = ss.insertSheet(UPDATES_TAB);
    tab.getRange(1, 1, 1, UPDATES_HEADER.length).setValues([UPDATES_HEADER]).setFontWeight('bold');
    tab.setFrozenRows(1);
  }
  var p = ss.getSheetByName(PLAYERS_TAB);
  if (p && p.getFrozenRows() === 0) {
    p.setFrozenRows(1);
    p.getRange(1, 1, 1, p.getLastColumn()).setFontWeight('bold');
  }
}
