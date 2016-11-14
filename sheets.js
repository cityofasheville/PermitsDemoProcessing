const Tabletop = require('tabletop');
const Utilities = require('./utilities.js');
const fs = require('fs');

const permits_sheet = '1TR3v7jKfw1as8RuXrzvDqwoQdrOltMreqlqwJnxwWDk';
// const target_sheet = '16-07528'; // Rocky main
//const target_sheet = '16-07556PZ'; // Rocky planning
//const target_sheet = '16-09014';
const target_sheet = '16-10083';
let sheet = null;

const applicationProcess = function (tasks, process, row, currentProcessState, output) {
  const task = row.Task, status = row.Status;
  const statusDate = row['Status Date'];

  if (task == 'Conditions of Approval') {
    currentProcessState.taskResetDate = statusDate; // We use this to initialize processes that aren't yet created
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
  else if (task == process) {
    currentProcessState.taskResetDate = statusDate;
    if (task == process && status == 'Complete') {
      currentProcessState.complete = true;
      tasks.push(createTask(process, task, status, currentProcessState.startDate, statusDate, null, '-', 0));
    }
    else {
      tasks.push(createTask(process, task, status, statusDate, statusDate, null, '-', 0));
    }
  }
  else if (! (task in currentProcessState)) {
    console.log("Creating a task in current process state: " + task + " with status " + status);
    currentProcessState[task] = {
      restart: true,
      start: currentProcessState.taskResetDate?currentProcessState.taskResetDate:statusDate,
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
          tasks.push(createTask(process, task, 'Required', statusDate, null, null, owner, level));
          currentProcessState[task].start = statusDate;
          currentProcessState[task].previous = tasks[tasks.length-1];
        }
      }
    break;
    case 'Sent':
     {
       if (currentProcessState[task].previous) {
         currentProcessState[task].previous.end = statusDate;
       }
       currentProcessState[task].restart = false;
       tasks.push(createTask(process, task, 'Sent', statusDate, statusDate, null, 'THIRD', level));
       currentProcessState[task].start = statusDate;
       currentProcessState[task].previous = tasks[tasks.length-1];
     }
     break;

   case 'Provided':
   case 'Accepted':
   case 'Approved':
    {
      if (currentProcessState[task].restart) {
        let insertedStatus = 'Required';
        let insertedOwner = owner;
        if (task == 'Air Quality Approval') {
          insertedStatus = 'Sent';
          insertedOwner='THIRD';
        }
        tasks.push(createTask(process, task, insertedStatus, currentProcessState[task].start, statusDate, null, insertedOwner, level));
      }
      if (currentProcessState[task].previous) {
        currentProcessState[task].previous.end = statusDate;
      }
      tasks.push(createTask(process, task, status, statusDate, statusDate, null, owner, level));
    }
    break;

    default:
      break;
  }
}

const reviewProcess = function (tasks, process, row, currentProcessState, output) {
  const task = row.Task, status = row.Status;
  const statusDate = row['Status Date'], due = row['Due Date'];

  if (task == 'Routing') {
    currentProcessState.taskResetDate = statusDate; // We use this to initialize review processes that aren't yet created
    for (item in currentProcessState) {
      currentProcessState[item].restart = true;
      currentProcessState[item].start = statusDate;
      currentProcessState[item].status = status;
      if (currentProcessState[item].previous) {
        currentProcessState[item].previous.end = statusDate;
      }
      currentProcessState[item].previous = null;
      currentProcessState[item].due = null
    }
  }
  else if (task == process) {
    currentProcessState.taskResetDate = statusDate;
    if (task == process && status == 'Complete') {
      currentProcessState.complete = true;
      tasks.push(createTask(process, task, status, currentProcessState.startDate, statusDate, null, '-', 0));
    }
  }
  else if (! (task in currentProcessState)) {
    currentProcessState[task] = {
      restart: true,
      start: currentProcessState.taskResetDate?currentProcessState.taskResetDate:statusDate,
      status: null,
      previous: null,
      due: null
    };
  }
  else if (status.startsWith('Approved')) {
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

          tasks.push(createTask(process, task, 'Pending Review', currentProcessState[task].start, statusDate, due, owner, level));
          tasks.push(createTask(process, task, 'In Review', statusDate, null, due, owner, level));
          currentProcessState[task].start = statusDate;
          currentProcessState[task].previous = tasks[tasks.length-1];
        }
      }
      break;
    case 'Hold for Revision':
     {
       tasks[tasks.length-1].end = statusDate;
       tasks.push(createTask(process, task, 'Hold for Revision', statusDate, null, null, 'CUST', level));
       currentProcessState[task].start = statusDate;
       currentProcessState[task].restart = true;
       currentProcessState[task].previous = tasks[tasks.length-1];
     }
     break;
    case 'Approved':
     {
       if (currentProcessState[task].restart) {
         tasks.push(createTask(process, task, 'Pending Review',
                    currentProcessState.taskResetDate?currentProcessState.taskResetDate:statusDate,
                    statusDate, due, owner, level));
         tasks.push(createTask(process, task, 'In Review', statusDate, statusDate, due, owner, level));
         tasks.push(createTask(process, task, 'Approved', statusDate, statusDate, due, owner, level));
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
    if (!('taskResetDate' in currentProcessState) && process != 'Ad Hoc Tasks') {
      currentProcessState.taskResetDate = null;
      currentProcessState.startDate = statusDate;
      tasks.push(createTask(process, process, 'Initiate', currentProcessState.startDate, statusDate, null, '-', 0));
    }

    if (process == 'Application Process') {
      applicationProcess(tasks, process, row, currentProcessState, output);
    }
    else if (process == 'Review Process') {
      reviewProcess(tasks, process, row, currentProcessState, output);
    }
    else if (process == 'Issuance') {
      if (task == process && status == 'Issue') {
        currentProcessState.complete = true;
        tasks.push(createTask(process, task, status, currentProcessState.startDate, statusDate, null, '-', 0));
      }
    }
    else if (process == 'Close Out Process') {
      if (task == process && status == 'Complete') {
        currentProcessState.complete = true;
        tasks.push(createTask(process, task, status, currentProcessState.startDate, statusDate, null, '-', 0));
      }
      else if (task != process) {
        tasks.push(createTask(process, task, status, statusDate, statusDate, null, '-', 1));
      }
    }
    else {
      tasks.push(createTask(process, task, status, statusDate, statusDate, null, '-', 1));
    }
  }
  for (let process in currentState) {
    if (!currentState[process].complete && process != 'Ad Hoc Tasks') {
      tasks.push(createTask (process, process, null, currentState[process].startDate, null, null, '-', 0));
    }
  }
  return tasks;
}

const createTask = function(process, task, status, start, end, due, owner, level) {
  let days = -1;
  if (due && start) {
    const d1 = new Date(start);
    const d2 = new Date(due);
    days = Utilities.workingDaysBetweenDates(d1, d2);
  }
  return { process, task, status, start, end, due, days, owner, level };
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
    'Id,Process,Task,Status,Start,End,Due Date,Owner,Level\n');
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
    let line = `${index},${row.process},${row.task},${row.status},`;
    line += `${row.start},${row.end},${row.due},${row.owner},${row.level}\n`;
    fs.write(output, line);
    console.log(line);
  });
}

Tabletop.init( { key: permits_sheet,
                 callback: processGoogleSpreadsheetData,
                 simpleSheet: false } );
