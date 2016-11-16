const Tabletop = require('tabletop');
const Utilities = require('./utilities.js');
const fs = require('fs');

const resetAllTasks = function (currentProcessState, statusDate) {
  currentProcessState.taskResetDate = statusDate; // We use this to initialize processes that aren't yet created
  for (taskItem in currentProcessState) {
    currentProcessState[taskItem].reset = true;
    currentProcessState[taskItem].start = statusDate;
    if (currentProcessState[taskItem].previous) {
      currentProcessState[taskItem].previous.end = statusDate;
    }
    currentProcessState[taskItem].previous = null;
  }
}

const applicationProcess = function (tasks, process, row, currentProcessState, output) {
  const task = row.Task, status = row.Status;
  const statusDate = row['Status Date'];

  if (task == process) {
    if (status == 'Contacted Applicant') {
      /*
      * I'm not sure this is right. This means that any new requirements
      * will be considered to have been imposed at this point.
      * I thought about also resetting all the tasks, but that ends up
      * creating duplicate 'Required' lines that don't make sense.
      *
      * Worth asking Diane. It may be better to just consider that all requirements
      * date from the point where we set Conditions of Approval.
      */
      currentProcessState.taskResetDate = statusDate;
    }

    if (status == 'Complete') {
      currentProcessState.complete = true;
      tasks.push(createTask(process, task, status, currentProcessState.startDate, statusDate, null, '-', 0));
    }
    else {
      tasks.push(createTask(process, task, status, statusDate, statusDate, null, '-', 0));
    }
  }
  else if (task == 'Conditions of Approval') {
    resetAllTasks(currentProcessState, statusDate);
  }
  else if (! (task in currentProcessState)) {
    currentProcessState[task] = {
      reset: true,
      start: currentProcessState.taskResetDate?currentProcessState.taskResetDate:statusDate,
      previous: null};
  }

  let switchStatus = status;
  if (status.startsWith('Accepted')) switchStatus = 'Accepted';
  let owner = 'CUST';
  let level = 1;
  switch (switchStatus) {
    case 'Required':
      {
        if (currentProcessState[task].reset) {
          currentProcessState[task].reset = false;
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
       currentProcessState[task].reset = false;
       tasks.push(createTask(process, task, 'Sent', statusDate, statusDate, null, 'THIRD', level));
       currentProcessState[task].start = statusDate;
       currentProcessState[task].previous = tasks[tasks.length-1];
     }
     break;

   case 'Provided':
   case 'Accepted':
   case 'Approved':
    {
      if (currentProcessState[task].reset) {
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
  /*
  * This is the 'DIVISION REVIEW' process (GPROCESS.R1_PROCESS_CODE) in the MASTER V4 workflow
  * Possible values of task are: Addressing, Building Review, Fire Review, Zoning Review plus the special tasks
  * Routing and Clearing House.
  *
  * Possible values of status for the regular tasks are: In Review, Hold for Revision, Approved,
  * Approved with Conditions, Approved - Fees Due, Approved - No Fees, Disapproved, Partial Approval,
  * Plan Review Waiver.
  *
  * The special task Clearing House has status values: Complete, Comment Letter Sent. The special task
  * Routing has status values: Routed Initial Review, Routed Second Review, Routed Third Review, Ruted Fourth Review
  *
  * The typical sequence for a regular task is a possibly repeated sequence of In Review and Hold for Revision, then
  * termination of the task by approval, disapproval or partial approval.
  *
  * A Routing task resets all the other tasks in the process and sets the start date against which the SLA will be applied.
  * The 'Routed Initial Review' task should always appear - subsequence Second, Third, etc., reviews follow Hold for Revision
  * statuses when the customer has been asked to revise plans. However, if only minor revisions are required, the examiner may
  * skip the routing step and either set directly to approved or possible review and hand back to the customer without resetting
  * other tasks. For this reason, we always want to reset a process when we encounter a Hold for Revision status.
  */
  if (task == process) { // Top-level process status item
    currentProcessState.taskResetDate = statusDate;
    if (task == process && status == 'Complete') {
      currentProcessState.complete = true;
      tasks.push(createTask(process, task, status, currentProcessState.startDate, statusDate, null, '-', 0));
    }
  }
  else if (task == 'Routing') {
    resetAllTasks(currentProcessState, statusDate);
  }
  else if (! (task in currentProcessState)) {
    currentProcessState[task] = {
      reset: true,
      start: currentProcessState.taskResetDate?currentProcessState.taskResetDate:statusDate,
      previous: null,
      due: null
    };
  }
  else if (status.startsWith('Approved')) {
    if (!(currentProcessState[task].reset)) {
      currentProcessState[task].start = statusDate;
    }
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
        if (currentProcessState[task].reset) {
          currentProcessState[task].reset = false;
          if (currentProcessState[task].previous) currentProcessState[task].previous.end = statusDate;

          tasks.push(createTask(process, task, 'Pending Review', currentProcessState[task].start, statusDate, due, owner, level));
          tasks.push(createTask(process, task, 'In Review', statusDate, null, due, owner, level));
          currentProcessState[task].start = statusDate;
          currentProcessState[task].previous = tasks[tasks.length-1];
        }
      }
      break;
    case 'Hold for Revision':
     {
       if (currentProcessState[task].previous) currentProcessState[task].previous.end = statusDate;
       tasks.push(createTask(process, task, 'Hold for Revision', statusDate, null, null, 'CUST', level));
       currentProcessState[task].start = statusDate;
       currentProcessState[task].reset = true;
       currentProcessState[task].previous = tasks[tasks.length-1];
     }
     break;
    case 'Approved':
     {
       if (currentProcessState[task].previous) currentProcessState[task].previous.end = statusDate;
       if (currentProcessState[task].reset) {
         tasks.push(createTask(process, task, 'Pending Review',
                    currentProcessState[task].start,
                    statusDate, due, owner, level));
         tasks.push(createTask(process, task, 'In Review', statusDate, statusDate, due, owner, level));
         tasks.push(createTask(process, task, 'Approved', statusDate, statusDate, due, owner, level));
       }
       else {
         // Is start date statusDate or some previous date?
         tasks.push(createTask(process, task, 'Approved', statusDate, statusDate, due, owner, level));
       }
     }
     break;
    default:
    console.log("UNKNOWN!!!!!!!!!!!!! " + process + ", task = " + task + ", status = " + status);
    //tasks.push(createTask(process, task, status, statusDate, statusDate, due, owner, level));

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

const permits_sheet = '1TR3v7jKfw1as8RuXrzvDqwoQdrOltMreqlqwJnxwWDk';
const target_sheet = '16-07528'; // Rocky main
//const target_sheet = '16-07556PZ'; // Rocky planning
//const target_sheet = '16-09014';
//const target_sheet = '16-10083';
let sheet = null;

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
    //console.log(line);
  });
}

Tabletop.init( { key: permits_sheet,
                 callback: processGoogleSpreadsheetData,
                 simpleSheet: false } );
