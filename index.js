const Tabletop = require('tabletop');
const Utilities = require('./utilities.js');
const fs = require('fs');

const permits_sheet = '1TR3v7jKfw1as8RuXrzvDqwoQdrOltMreqlqwJnxwWDk';
//const target_sheet = '16-07528'; // Rocky main
//const target_sheet = '16-07556PZ'; // Rocky planning
//const target_sheet = '16-09014';
const target_sheet = '16-10083';
let sheet = null;

const initiators = {
  'Application Process': 'Conditions of Approval',
  'Review Process': 'Routing',
  'Issuance': null,
  'Close Out Process': 'Holds',
};

const getPrior = function (elements, start, task, process) {
  /*  Prior is first previous we find that:
   *    - is the same task OR
   *    - is an initiator task OR
   *    - is the first task in the process
   *  If we find nothing, then the task is a singleton/event
   */
  let prior = null;
  let done = false;
  for (let i=start; i>=0 && !done; --i) {
    let t = elements[i];
    if (t.Task == task || t.Task == initiators[process]) {
      prior = t;
      done = true;
    }
    else if (t.Process == process && process != 'Ad Hoc Tasks') {
      prior = t;
    }
  }
  return prior;
}

const processGoogleSpreadsheetData = function(data, tabletop) {
  sheet = data[target_sheet];
  const elements = sheet.elements;

  let output = process.stdout.fd;
  if (process.argv.length > 2) {
    const fname = (process.argv[2][0] == '/')?process.argv[2]:`./${process.argv[2]}`;
    console.log("Try to open " + fname);
    output = fs.openSync(fname, 'w');
  }

  fs.write(output,
    'Current Process,Current Task, Current Status,' +
    'Start,End,Duration,' +
    'Due Date,SLA Days,' +
    'Prior Process,Prior Task,Prior Status,' +
    '\n');
  for (let i=0; i< elements.length; ++i) {
    const task = elements[i];
    let prior = null, dueDays = null;
    if (i > 0) prior = getPrior(elements, i-1, task.Task, task.Process);
    if (!prior) prior = {Process: '-', Task: '-', Status: '-', 'Status Date': 'NULL'};
    if (task['Status Date'] != 'NULL' && task['Due Date'] != 'NULL') {
      let statusDate = new Date(task['Status Date']);
      let dueDate = new Date(task['Due Date']);
      dueDays = Utilities.workingDaysBetweenDates(statusDate, dueDate);
    }
    let startDate = null, endDate = null;
    if (prior['Status Date'] != 'NULL') startDate = new Date(prior['Status Date']);
    if (task['Status Date'] != 'NULL') endDate = new Date(task['Status Date']);
    let diffDays = Utilities.workingDaysBetweenDates(startDate, endDate);
    let line = [
      task.Process, task.Task, task.Status,
      prior['Status Date'], task['Status Date'], diffDays,
      task['Due Date'], dueDays,
      prior.Process, prior.Task, prior.Status
    ];

//      Array.prototype.push.apply(line, [, dueDays]);
    fs.write(output, line.join() + '\n');
  }
}

Tabletop.init( { key: permits_sheet,
                 callback: processGoogleSpreadsheetData,
                 simpleSheet: false } );
