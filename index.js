const Tabletop = require('tabletop');
const Utilities = require('./utilities.js');
const fs = require('fs');

const permits_sheet = '1TR3v7jKfw1as8RuXrzvDqwoQdrOltMreqlqwJnxwWDk';
const target_sheet = '16-07528'; // Rocky main
//const target_sheet = '16-07556PZ'; // Rocky planning
//const target_sheet = '16-09014';
// const target_sheet = '16-10083';
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

const applicationProcess = function (tasks, process, row, currentProcessState, output) {
  const task = row.Task, status = row.Status;
  const statusDate = row['Status Date'];
  /*
   * So I think the way we do this is we have (in currentProcessState) a "required" array.
   * Anything that gets referred to is added, with an initial date triggered when it first appears
   * and an end date that is set by particular status values (accepted, provided, etc.)
   * We output things when they hit the end date and then output any that don't have end dates at the end of the routine.
   *
   * NOTE: Let's have a "sum up" call to each process at the end and let each routine (app, review, issuance, close out)
   * take care of its own, i.e., move it out of the masterv4 routine.
  */
  if (task == 'Items Pending') {
    currentProcessState.routingStatusDate = statusDate; // We use this to initialize review processes that aren't yet created
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
      start: currentProcessState.routingStatusDate?currentProcessState.routingStatusDate:statusDate,
      status: null, previous: null};
  }

  let switchStatus = status;
  if (status.startsWith('Accepted')) switchStatus = 'Accepted';
  let owner = 'CUST';
  let level = 1;
  switch (switchStatus) {
    case 'Required':
      {
        if (currentProcessState[task].restart) {
          currentProcessState[task].restart = false;
          tasks.push({
            process,
            task,
            status: 'Required',
            start: statusDate,
            end: null,
            owner,
            level
          });
          currentProcessState[task].start = statusDate;
          currentProcessState[task].previous = tasks[tasks.length-1];
        }
      }
    break;
    case 'Provided':
      {
       if (currentProcessState[task].previous) {
         currentProcessState[task].previous.end = statusDate;
       }
      //  tasks.push({
      //    process, task,
      //    status: "Provided",
      //    start: statusDate,
      //    end: statusDate,
      //    owner,
      //    level
      //  });
     }
     break;
   case 'Accepted':
    {
      if (currentProcessState[task].previous) {
        currentProcessState[task].previous.end = statusDate;
      }
      // tasks.push({
      //   process, task,
      //   status: "Accepted",
      //   start: statusDate,
      //   end: statusDate,
      //   owner,
      //   level
      // });
    }
    break;

    default:
      break;
  }
}

const reviewProcess = function (tasks, process, row, currentProcessState, output) {
  const task = row.Task, status = row.Status;
  const statusDate = row['Status Date'];
  /*
   * Routing task:
   *    - Resets any division task to restart. he next in each division will insert a "Ready for review"
   * Hold for Revision status:
  */
  if (task == 'Routing') {
    currentProcessState.routingStatusDate = statusDate; // We use this to initialize review processes that aren't yet created
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
      start: currentProcessState.routingStatusDate?currentProcessState.routingStatusDate:statusDate,
      status: null, previous: null};
  }
  else if (status.startsWith('Approved')) {
    currentProcessState[task].restart = true;
    currentProcessState[task].start = statusDate;
    currentProcessState[task].status = status;
    if (currentProcessState[task].previous) {
      currentProcessState[task].previous.end = statusDate;
    }
    currentProcessState[task].previous = null;
  }
  let switchStatus = status;
  if (status.startsWith('Approved')) switchStatus = 'Approved';
  let owner = 'DSD';
  let level = 1;
  switch (switchStatus) {
    case 'In Review':
      {
        if (currentProcessState[task].restart) {
          currentProcessState[task].restart = false;
          tasks.push({
            process,
            task,
            status: 'Pending Review',
            start: currentProcessState[task].start,
            end: statusDate,
            owner,
            level
          });
          tasks.push({
            process,
            task,
            status: 'In Review',
            start: statusDate,
            end: null,
            owner,
            level
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
         status: 'Hold for Rev.',
         start: statusDate,
         end: null,
         owner: 'CUST',
         level
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
           start: currentProcessState.routingStatusDate?currentProcessState.routingStatusDate:statusDate,
           end: statusDate,
           owner,
           level
         });
         tasks.push({
           process,
           task,
           status: "In Review",
           start: statusDate,
           end: statusDate,
           owner,
           level
         });
         tasks.push({
           process, task,
           status: "Approved",
           start: statusDate,
           end: statusDate,
           owner,
           level
         });
       }
     }
     break;
    default:
      break;
  }
}

const wf_masterv4 = function (elements, output) {
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
    if (process == 'Application Process') {
      if (!('routingStatusDate' in currentProcessState)) {
        currentProcessState.routingStatusDate = null;
        currentProcessState.startDate = statusDate;
      }
      applicationProcess(tasks, process, row, currentProcessState, output);
      if (task == process && status == 'Complete') {
        currentProcessState.complete = true;
        tasks.push({
          process, task, status,
          start: currentProcessState.startDate,
          end: statusDate,
          owner: 'N/A',
          level: 0
        });
      }
    }
    else if (process == 'Review Process') {
      if (!('routingStatusDate' in currentProcessState)) {
        currentProcessState.routingStatusDate = null;
        currentProcessState.startDate = statusDate;
      }
      reviewProcess(tasks, process, row, currentProcessState, output);
      if (task == process && status == 'Complete') {
        currentProcessState.complete = true;
        tasks.push({
          process, task, status,
          start: currentProcessState.startDate,
          end: statusDate,
          owner: 'N/A',
          level: 0
        });
      }
    }
    else if (process == 'Issuance') {
      if (!('routingStatusDate' in currentProcessState)) {
        currentProcessState.routingStatusDate = null;
        currentProcessState.startDate = statusDate;
      }
      //applicationProcess(tasks, process, row, currentProcessState, output);
      if (task == process && status == 'Issue') {
        currentProcessState.complete = true;
        tasks.push({
          process, task, status,
          start: currentProcessState.startDate,
          end: statusDate,
          owner: 'N/A',
          level: 0
        });
      }
    }
    else if (process == 'Close Out Process') {
      if (!('routingStatusDate' in currentProcessState)) {
        currentProcessState.routingStatusDate = null;
        currentProcessState.startDate = statusDate;
      }
      //applicationProcess(tasks, process, row, currentProcessState, output);
      if (task == process && status == 'Complete') {
        currentProcessState.complete = true;
        tasks.push({
          process, task, status,
          start: currentProcessState.startDate,
          end: statusDate,
          owner: 'N/A',
          level: 0
        });
      }
    }
  }
  for (let process in currentState) {
    if (!currentState[process].complete) {
      tasks.push({
        process,
        task: process,
        status: null,
        start: currentState[process].startDate,
        end: null,
        owner: 'N/A',
        level: 0
      });
    }
  }
  return tasks;
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
    'ID\t    Process\t    Task\t    Status\t        Start    \t         End    \tOwner\tLevel\n');
  let tasks = [];

  if (elements[0].Workflow == 'MASTER V4') {
    tasks = wf_masterv4(elements, output);
  }
  else {
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
    line += `${row.start}\t${row.end}\t${row.owner}\t${row.level}\n`;
    fs.write(output, line);
  });
}

Tabletop.init( { key: permits_sheet,
                 callback: processGoogleSpreadsheetData,
                 simpleSheet: false } );
