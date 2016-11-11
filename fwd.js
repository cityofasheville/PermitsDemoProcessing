const Tabletop = require('tabletop');
const Utilities = require('./utilities.js');
const fs = require('fs');

const permits_sheet = '1TR3v7jKfw1as8RuXrzvDqwoQdrOltMreqlqwJnxwWDk';
const target_sheet = '16-07528'; // Rocky main
//const target_sheet = '16-07556PZ'; // Rocky planning
//const target_sheet = '16-09014';
//const target_sheet = '16-10083';
let sheet = null;

const initiators = {
  'Application Process': 'Conditions of Approval',
  'Review Process': 'Routing',
  'Issuance': null,
  'Close Out Process': 'Holds',
};

const terminators = {
  'Application Process': 'Provided',
  'Review Process': 'Approved',
  'Issuance': null,
  'Close Out Process': null,
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

let routingStatusDate = null;
let counter = 0;
const reviewProcess = function (tasks, process, row, currentProcessState, output) {
  const task = row.Task, status = row.Status;
  const statusDate = row['Status Date'];
//  console.log("Current process: " + process + ", task = " + task + ", status = " + status);
  /*
   * Routing task:
   *    - Resets any division task to restart. he next in each division will insert a "Ready for review"
   * Hold for Revision status:
  */
  if (task == 'Routing') {
    routingStatusDate = statusDate; // We use this to initialize review processes that haven't been created yet
    //console.log("Setting routingStatusDate to " + routingStatusDate + " at index " + counter);
    for (item in currentProcessState) {
      currentProcessState[item].restart = true;
      currentProcessState[item].start = statusDate;
      currentProcessState[item].status = status;
      if (currentProcessState[item].previous) {
        currentProcessState[item].previous.end = statusDate;
      }
      currentProcessState[item].previous = null;
    }
  }
  else if (! (task in currentProcessState)) {
    currentProcessState[task] = {
      restart: true,
      start: routingStatusDate?routingStatusDate:statusDate,
      status: null, previous: null};
  }
  else if (status == 'Approved') {
    currentProcessState[task].restart = true;
    currentProcessState[task].start = statusDate;
    currentProcessState[task].status = status;
    if (currentProcessState[task].previous) {
      currentProcessState[task].previous.end = statusDate;
    }
    currentProcessState[task].previous = null;
  }
  counter++;
  switch (status) {
    case 'In Review':
      {
        //console.log("In review " + task + " routingStatusDate = " + routingStatusDate);
        if (currentProcessState[task].restart) {
          currentProcessState[task].restart = false;
          tasks.push({
            process,
            task,
            status: 'Pending Review',
            start: currentProcessState[task].start,
            end: statusDate
          });
          tasks.push({
            process,
            task,
            status: 'In Review',
            start: statusDate,
            end: null
          });
          currentProcessState[task].start = statusDate;
          currentProcessState[task].previous = tasks[tasks.length-1];
        }
      }
      break;
    case 'Hold for Revision':
     {
       tasks[tasks.length-1].end = statusDate;
       tasks.push({
         process,
         task,
         status: 'Cust Revision',
         start: statusDate,
         end: null
       });
       currentProcessState[task].start = statusDate;
       currentProcessState[task].restart = true;
       currentProcessState[task].previous = tasks[tasks.length-1];
     }
     break;
    case 'Approved':
     {
       if (currentProcessState[task].restart) {
         tasks.push({
           process,
           task,
           status: 'Pending Review',
           start: routingStatusDate?routingStatusDate:statusDate,
           end: statusDate
         });
         tasks.push({
           process,
           task,
           status: "In Review",
           start: statusDate,
           end: statusDate
         });
         tasks.push({
           process, task,
           status: "Approved",
           start: statusDate,
           end: statusDate
         });
       }
     }
     break;
    default:
      break;
  }

}

const processGoogleSpreadsheetData = function(data, tabletop) {
  sheet = data[target_sheet];
  const elements = sheet.elements;

  let output = process.stdout.fd;
  if (process.argv.length > 2) {
    const fname = (process.argv[2][0] == '/')?process.argv[2]:`./${process.argv[2]}`;
    output = fs.openSync(fname, 'w');
  }

  fs.write(output,
    'ID\t    Process\t    Task\t    Status\t        Start    \t         End\n');

  let currentState = {};
  let tasks = [];
  for (let i=0; i< elements.length; ++i) {
    const row = elements[i];
    const process = row.Process, task = row.Task, status = row.Status;
    const statusDate = row['Status Date'];
    if (!(process in currentState)) {
      currentState[process] = {};
    }
    let currentProcessState = currentState[process];
    if (process == 'Review Process') {
      reviewProcess(tasks, process, row, currentProcessState, output);
    }
    else {
      let prior = null, dueDays = null;
      if (i > 0) prior = getPrior(elements, i-1, task, process);
      if (!prior) prior = {Process: '-', Task: '-', Status: '-', 'Status Date': 'NULL'};
      if (row['Status Date'] != 'NULL' && row['Due Date'] != 'NULL') {
        let statusDate = new Date(row['Status Date']);
        let dueDate = new Date(row['Due Date']);
        dueDays = Utilities.workingDaysBetweenDates(statusDate, dueDate);
      }
      let startDate = null, endDate = null;
      if (prior['Status Date'] != 'NULL') startDate = new Date(prior['Status Date']);
      if (row['Status Date'] != 'NULL') endDate = new Date(row['Status Date']);
      let diffDays = Utilities.workingDaysBetweenDates(startDate, endDate);
      let line = [
        process, task, row.Status,
        prior['Status Date'], row['Status Date'], diffDays,
        row['Due Date'], dueDays,
        prior.Process, prior.Task, prior.Status
      ];
    }
  }

  tasks.forEach( (row, index) => {
    let line = `${index}\t${row.process}\t${row.task}\t${row.status}\t`;
    line += `${row.start}\t${row.end}\n`;
    fs.write(output, line);
  });
}

Tabletop.init( { key: permits_sheet,
                 callback: processGoogleSpreadsheetData,
                 simpleSheet: false } );
