const Tabletop = require('tabletop');
const Utilities = require('./utilities.js');
const fs = require('fs');
var parse = require('csv-parse/lib/sync');

let permitNum = -1;

const createTask = function(process, task, status, start, end, due, owner, level) {
  let days = -1;
  if (due && start) {
    const d1 = new Date(start);
    const d2 = new Date(due);
    days = Utilities.workingDaysBetweenDates(d1, d2);
  }
  return { B1_ALT_ID: permitNum, process, task, status, start, end, due, days, owner, level };
}

const resetAllTasks = function (currentProcessState, statusDate) {
  for (taskItem in currentProcessState) {
    currentProcessState[taskItem].reset = true;
    currentProcessState[taskItem].start = statusDate;
    if (currentProcessState[taskItem].previous) {
      currentProcessState[taskItem].previous.end = statusDate;
    }
    currentProcessState[taskItem].previous = null;
  }
}

const applicationProcess = function (tasks, process, row, currentProcessState) {
  const task = row.Task, status = row.Status, statusDate = row['Status Date'];

  if (!('processStartDate' in currentProcessState)) { // First time here
    currentProcessState.processStartDate = statusDate; // This is the start of the whole process
    currentProcessState.processRoundStartDate = null; // Start of the current round
    tasks.push(createTask(process, process, 'Start', statusDate, statusDate, null, '-', 0));
  }

  /*
   * Special tasks: these tasks start, reset or end the process
   */
  const specials = { 'Application Process': 0, 'Conditions of Approval': 1 };

  if (task in specials) {
    /*
     * Not 100% sure this is right. A new "round" starts not only at the start
     * of the process and when 'Conditions of Approval' status occurs, but also
     * whenever a 'Contacted Applicant' status occurs.
     *
     * Worth asking Diane. It may be better to just consider that all requirements
     * date from the point where we set Conditions of Approval.
     */
    currentProcessState.processRoundStartDate = statusDate;
    if (task == 'Conditions of Approval') {
      resetAllTasks(currentProcessState, statusDate);
    }
    if (status == 'Complete') {
      currentProcessState.complete = true;
      tasks.push(createTask(process, task, status, currentProcessState.processStartDate, statusDate, null, '-', specials[task]));
    }
    else {
      tasks.push(createTask(process, task, status, statusDate, statusDate, null, '-', specials[task]));
    }
    return;
  }

  /*
   * If we're here, we have a regular task
   */
  if (! (task in currentProcessState)) { // Initialize this task if we see it for the furst time
    currentProcessState[task] = {
      reset: true,
      start: currentProcessState.processRoundStartDate?currentProcessState.processRoundStartDate:statusDate,
      previous: null
    };
  }

  const terminators = { 'Provided': 1, 'Accepted - within 10% of ICC Value':1, 'Approved':1,
                        'Approved - Pending Payment':1,
                        'Disapproved':1, 'Final Release':1, 'Incomplete - Partial Approval':1,
                        'Backflow Device Not Required':1, 'Backflow Device Required':1 };
  const waits = { 'Sent': 'THIRD', 'NULL':'CUST', 'Approval Required':'CUST',
                  'BC Septic Approval Required':'CUST',
                  'BC Septic Approval Req.':'CUST',
                  'Hold - See Comment':'CUST', 'Hold - See Comments':'CUST',
                  'Required':'CUST',
                  'Verification Requested':1 };
  let switchStatus = status;
  if (status in terminators) switchStatus = 'TERMINATOR';
  if (status in waits) switchStatus = 'WAITS';

  // Complete the previous step, if it exists
  if (currentProcessState[task].previous) {
    currentProcessState[task].previous.end = statusDate;
    currentProcessState[task].previous = null;
  }

  switch (switchStatus) {
    case 'WAITS':
      {
        if (currentProcessState[task].reset) {
          currentProcessState[task].reset = false;
          tasks.push(createTask(process, task, status, statusDate, null, null, waits[status], 1));
          currentProcessState[task].start = statusDate;
          currentProcessState[task].previous = tasks[tasks.length-1];
        }
      }
      break;

    case 'TERMINATOR':
    {
      tasks.push(createTask(process, task, status, statusDate, statusDate, null, 'CUST', 1));
    }
    break;

    default:
      console.log(permitNum + ": Unknown Application Process task status: " + process + "." + task + "." + status);
      break;
  }
}

/*
* This is the 'DIVISION REVIEW' process (GPROCESS.R1_PROCESS_CODE) in the MASTER V4 workflow
* Possible values of task are: Addressing, Building Review, Fire Review, Zoning Review plus the special tasks
* Routing, Clearing House and Review Process.
*
* A Routing task resets all the other tasks in the process and sets the start date against which the SLA will be applied.
* The 'Routed Initial Review' task should always appear - subsequenct Second, Third, etc., reviews follow Hold for Revision
* statuses when the customer has been asked to revise plans. However, if only minor revisions are required, the examiner may
* skip the routing step and either set directly to approved or possible review and hand back to the customer without resetting
* other tasks. For this reason, we always want to reset a process when we encounter a Hold for Revision status.
*
* The special task Clearing House has status values: Complete, Comment Letter Sent. The special task
* Routing has status values: Routed Initial Review, Routed Second Review, Routed Third Review, Ruted Fourth Review
*
* Possible values of status for the regular tasks are: In Review, Hold for Revision, Approved,
* Approved with Conditions, Approved - Fees Due, Approved - No Fees, Disapproved, Partial Approval,
* Plan Review Waiver.
*
* The typical sequence for a regular task is a possibly repeated sequence of In Review and Hold for Revision, then
* termination of the task by approval, disapproval or partial approval.
*/
const reviewProcess = function (tasks, process, row, currentProcessState) {
  const task = row.Task, status = row.Status;
  const statusDate = row['Status Date'], due = row['Due Date'];

  if (!('processStartDate' in currentProcessState)) { // First time here
    currentProcessState.processStartDate = statusDate; // This is the start of the whole process
    currentProcessState.processRoundStartDate = null; // this is the start of the current round (initial, second, etc. review)
    tasks.push(createTask(process, process, 'Start', statusDate, statusDate, null, '-', 0));
  }
  /*
   * Special tasks: these tasks start, reset or end the process
   */
  const specials = {'Review Process': 0, 'Routing': 1, 'Clearing House': 1};
  if (task in specials) {
    let startDate = statusDate;
    if (task == 'Review Process' || task == 'Routing') { // Process start or restart
      currentProcessState.processRoundStartDate = statusDate;
      if (task == 'Routing') resetAllTasks(currentProcessState, statusDate);
      if (task == 'Review Process' && status == 'Complete') {
        currentProcessState.complete = true;
        startDate = currentProcessState.processStartDate;
      }
    }
    tasks.push(createTask(process, task, status, startDate, statusDate, null, '-', specials[task]));
    return;
  }

  /*
   * If we're here, we have a regular task.
   */
  const terminators = {  'Approved':1, 'Approved with Conditions':1, 'Approved - Fees Due':1,
                          'Approved - No Fees':1, 'Disapproved':1, 'Partial Approval':1,
                          'Plan Review Waiver':1 };
  const terminator = (status in terminators);
  let switchStatus = terminator?'TERMINATOR':status;
  let owner = 'DSD';
  let level = 1;
  if (!(task in currentProcessState)) { // Initialize this task if we see it for the first time
    currentProcessState[task] = {
      reset: true,
      start: currentProcessState.processRoundStartDate?currentProcessState.processRoundStartDate:statusDate,
      previous: null,
      due: null
    };
  }
  // Complete the previous step, if it exists.
  if (currentProcessState[task].previous) {
    currentProcessState[task].previous.end = statusDate;
    currentProcessState[task].previous = null;
  }
  // This takes care of the case when examiners skip routing
  console.log("Review " + process + "." + task + "." + status + " ... " + terminator);
  if (terminator && !(currentProcessState[task].reset)) {
      currentProcessState[task].start = statusDate;
      currentProcessState[task].reset = true;
      console.log("Reset start to " + statusDate);
  }

  switch (switchStatus) {
    case 'In Review':
      {
        if (currentProcessState[task].reset) {
          currentProcessState[task].reset = false;
          tasks.push(createTask(process, task, 'Pending Review', currentProcessState[task].start, statusDate, due, owner, level));
          currentProcessState[task].start = statusDate;
        }
        tasks.push(createTask(process, task, 'In Review', statusDate, null, due, owner, level));
        currentProcessState[task].previous = tasks[tasks.length-1];
      }
      break;
    case 'Hold for Revision':
     {
       tasks.push(createTask(process, task, 'Hold for Revision', statusDate, null, null, 'CUST', level));
       //currentProcessState[task].reset = true;
       currentProcessState[task].start = statusDate;
       currentProcessState[task].previous = tasks[tasks.length-1];
     }
     break;

    case 'NULL':
      {
        tasks.push(createTask(process, task, 'Pending Review', currentProcessState.processRoundStartDate, null, null, 'DSD', level));
        currentProcessState[task].reset = false;
        currentProcessState[task].start = currentProcessState.processRoundStartDate;
        currentProcessState[task].previous = tasks[tasks.length-1];
      }
      break;

    case 'TERMINATOR':
     {
       if (currentProcessState[task].reset) {
         tasks.push(createTask(process, task, 'Pending Review', currentProcessState[task].start,
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
      console.log(permitNum + ": Unknown Review: " + process + ", task = " + task + ", status = " + status + ", date " + statusDate);
    //tasks.push(createTask(process, task, status, statusDate, statusDate, due, owner, level));

      break;
  }
}

const issuanceProcess = function (tasks, process, row, currentProcessState) {
  const task = row.Task, status = row.Status, statusDate = row['Status Date'];
  if (!('processStartDate' in currentProcessState)) { // First time here
    currentProcessState.processStartDate = statusDate; // This is the start of the whole process
    tasks.push(createTask(process, process, 'Start', statusDate, statusDate, null, '-', 0));
  }
  if (task == process && status == 'Issue') {
    currentProcessState.complete = true;
    tasks.push(createTask(process, task, status, currentProcessState.processStartDate, statusDate, null, '-', 0));
  }
}

const closeoutProcess = function (tasks, process, row, currentProcessState) {
  const task = row.Task, status = row.Status, statusDate = row['Status Date'];
  if (!('processStartDate' in currentProcessState)) { // First time here
    currentProcessState.processStartDate = statusDate; // This is the start of the whole process
    tasks.push(createTask(process, process, 'Start', statusDate, statusDate, null, '-', 0));
  }

  if (task == process && status == 'Complete') {
    currentProcessState.complete = true;
    tasks.push(createTask(process, task, status, currentProcessState.processStartDate, statusDate, null, '-', 0));
  }
  else if (task != process) {
    const locStatus = (status == 'NULL')?'Pending':status;
    let startDate = statusDate, endDate = statusDate;
    if (startDate == 'NULL') {
      startDate = currentProcessState.processStartDate;
      endDate = null;
    }
    tasks.push(createTask(process, task, locStatus, startDate, endDate, null, '-', 1));
  }
}

const wf_masterv4 = function (elements, output) {
  let currentState = {};
  let tasks = [];
  for (let i=0; i< elements.length; ++i) {
    const row = elements[i];
    const process = row.Process, task = row.Task, status = row.Status, statusDate = row['Status Date'];

    if (!(process in currentState)) {
      currentState[process] = {};
    }
    let currentProcessState = currentState[process];

    switch (process) {
      case 'Application Process':
      {
        applicationProcess(tasks, process, row, currentProcessState);
      }
      break;

      case 'Review Process':
        reviewProcess(tasks, process, row, currentProcessState);
        break;

      case 'Issuance':
        issuanceProcess(tasks, process, row, currentProcessState);
        break;

      case 'Close Out Process':
        closeoutProcess(tasks, process, row, currentProcessState);
        break;

      default: // Ad Hoc and other
        {
          if (!('processRoundStartDate' in currentProcessState) && process != 'Ad Hoc Tasks') {
            currentProcessState.processRoundStartDate = null;
            currentProcessState.startDate = statusDate;
            tasks.push(createTask(process, process, 'Start', currentProcessState.startDate, statusDate, null, '-', 0));
          }
          tasks.push(createTask(process, task, status, statusDate, statusDate, null, '-', 1));
        }
        break;
    }
  }

  return tasks;
}

let target_sheet = '16-07528'; // Rocky main
//target_sheet = '16-07556PZ'; // Rocky planning
//target_sheet = '16-09014';
//target_sheet = '16-10083';
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
    console.log("Unknown workflow " + elements[0].Workflow);
  }

  tasks.forEach( (row, index) => {
    let line = `${index},${row.process},${row.task},${row.status},`;
    line += `${row.start},${row.end},${row.due},${row.owner},${row.level}\n`;
    fs.writeSync(output, line);
    //console.log(line);
  });
}

/*
 * MAIN PROGRAM
 */

const processingMode = 'sheets';
if (processingMode == 'sheets') {
  const permits_sheet = '1TR3v7jKfw1as8RuXrzvDqwoQdrOltMreqlqwJnxwWDk';
  Tabletop.init( { key: permits_sheet,
                   callback: processGoogleSpreadsheetData,
                   simpleSheet: false } );
}
else { // read a csv file
  let input = fs.openSync('masterv4.csv', 'r');
  let data = fs.readFileSync(input);
  let records = parse(data, {columns: true});

  let output = process.stdout.fd;
  if (process.argv.length > 2) {
    const fname = (process.argv[2][0] == '/')?process.argv[2]:`./${process.argv[2]}`;
    output = fs.openSync(fname, 'w');
  }

  fs.write(output,
    'B1_ALT_ID,Id,Process,Task,Status,Start,End,Due Date,Owner,Level\n');

  // Now process permit by permit
  let done = false, cur = 0, id = null, count = 0;
  let elements = [];
  while (!done) {
    if (id == null) id = records[cur].B1_ALT_ID;
    if (cur >= records.length) done = true;
    if (done || records[cur].B1_ALT_ID != id) {// Process a permit
      ++count;
      let tasks = [];
      permitNum = elements[0].B1_ALT_ID;
      if (elements[0].Workflow == 'MASTER V4') {
        tasks = wf_masterv4(elements, output);
      }
      else {
        console.log("Unknown workflow " + elements[0].Workflow);
      }

      tasks.forEach( (row, index) => {
        let line = `${row.B1_ALT_ID},${index},${row.process},${row.task},${row.status},`;
        line += `${row.start},${row.end},${row.due},${row.owner},${row.level}\n`;
        fs.writeSync(output, line);
        //console.log(line);
      });
      elements = [];
      id = null;
    }
    else {
      elements.push(records[cur]);
      ++cur;
    }
    if (cur >= records.length-1) done = true;
  }
  console.log("The length of the file is " + records.length);
  console.log("Done processing - total permits = " + count);
}
