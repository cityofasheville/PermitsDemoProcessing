const Tabletop = require('tabletop');

const initiators = {
  'Application Process': 'Conditions of Approval',
  'Review Process': 'Routing',
  'Issuance': null,
  'Close Out Process': 'Holds',
};

const permits_sheet = '1TR3v7jKfw1as8RuXrzvDqwoQdrOltMreqlqwJnxwWDk';
const target_sheet = '16-07528'; // Rocky main
//const target_sheet = '16-07556PZ'; // Rocky planning
//const target_sheet = '16-09014';
//const target_sheet = '16-10083';
let sheet = null;

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

  console.log('Current Process,Current Task,Current Status,Prior Process,Prior Task, Prior Status');
  for (let i=0; i< elements.length; ++i) {
    if (i == 0) continue;
    const task = elements[i]
    let prior = getPrior(elements, i-1, task.Task, task.Process);
    if (prior) {
      console.log(`${task.Process},${task.Task},${task.Status},${prior.Process},${prior.Task},${prior.Status}`);
    }
    else {
      console.log(`${task.Process},${task.Task},${task.Status},-,-,-`);
    }
  }
}

Tabletop.init( { key: permits_sheet,
                 callback: processGoogleSpreadsheetData,
                 simpleSheet: false } );
