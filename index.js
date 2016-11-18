const Tabletop = require('tabletop');
const Utilities = require('./utilities.js');
const fs = require('fs');
var parse = require('csv-parse/lib/sync');

let permitNum = -1;

const createTask = function(process, task, status, start, end, due, owner, level, row, trip = 0) {
  if (!row) throw ("No row " + task);
  let days = -1;
  if (due && start) {
    const d1 = new Date(start);
    const d2 = new Date(due);
    days = Utilities.workingDaysBetweenDates(d1, d2);
  }
  return { B1_ALT_ID: permitNum, process, task, status, start, end, due, days, owner, level, trip,
           type:row.B1_PER_TYPE,subtype:row.B1_PER_SUB_TYPE,category:row.B1_PER_CATEGORY,
           appdate:row['Application Date'],appstatus:row['Application Status'],
           appstatusdate:row['Application Status Date'],agencycode:row.SD_AGENCY_CODE,
           comment:row.SD_COMMENT };
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
    tasks.push(createTask(process, process, 'Start', statusDate, statusDate, null, '-', 0, row));
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
      tasks.push(createTask(process, task, status, currentProcessState.processStartDate, statusDate, null, '-', specials[task], row));
    }
    else {
      tasks.push(createTask(process, task, status, statusDate, statusDate, null, '-', specials[task], row));
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
          tasks.push(createTask(process, task, status, statusDate, null, null, waits[status], 1, row));
          currentProcessState[task].start = statusDate;
          currentProcessState[task].previous = tasks[tasks.length-1];
        }
      }
      break;

    case 'TERMINATOR':
    {
      tasks.push(createTask(process, task, status, statusDate, statusDate, null, 'CUST', 1, row));
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
let reviewTrip = -1;
const reviewProcess = function (tasks, process, row, currentProcessState) {
  const task = row.Task, status = row.Status;
  const statusDate = row['Status Date'], due = row['Due Date'];

  if (!('processStartDate' in currentProcessState)) { // First time here
    currentProcessState.processStartDate = statusDate; // This is the start of the whole process
    currentProcessState.processRoundStartDate = null; // this is the start of the current round (initial, second, etc. review)
    tasks.push(createTask(process, process, 'Start', statusDate, statusDate, null, '-', 0, row));
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
    tasks.push(createTask(process, task, status, startDate, statusDate, null, '-', specials[task], row));
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
      trip: 0,
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
  if (terminator && !(currentProcessState[task].reset)) {
      currentProcessState[task].start = statusDate;
      currentProcessState[task].reset = true;
  }

  if (currentProcessState[task].reset) {
    currentProcessState[task].trip = currentProcessState[task].trip + 1;
  }
  switch (switchStatus) {
    case 'In Review':
      {
        if (currentProcessState[task].reset) {
          currentProcessState[task].reset = false;
          tasks.push(createTask(process, task, 'Pending Review', currentProcessState[task].start, statusDate, due, owner, level, row, currentProcessState[task].trip));
          currentProcessState[task].start = statusDate;
        }
        tasks.push(createTask(process, task, 'In Review', statusDate, null, due, owner, level, row,currentProcessState[task].trip));
        currentProcessState[task].previous = tasks[tasks.length-1];
      }
      break;
    case 'Hold for Revision':
     {
       tasks.push(createTask(process, task, 'Hold for Revision', statusDate, null, null, 'CUST', level, row,currentProcessState[task].trip));
       //currentProcessState[task].reset = true;
       currentProcessState[task].start = statusDate;
       currentProcessState[task].previous = tasks[tasks.length-1];
     }
     break;

    case 'NULL':
      {
        tasks.push(createTask(process, task, 'Pending Review', currentProcessState.processRoundStartDate, null, null, 'DSD', level, row,currentProcessState[task].trip));
        currentProcessState[task].reset = false;
        currentProcessState[task].start = currentProcessState.processRoundStartDate;
        currentProcessState[task].previous = tasks[tasks.length-1];
      }
      break;

    case 'TERMINATOR':
     {
       if (currentProcessState[task].reset) {
         tasks.push(createTask(process, task, 'Pending Review', currentProcessState[task].start,
                    statusDate, due, owner, level, row,currentProcessState[task].trip));
         tasks.push(createTask(process, task, 'In Review', statusDate, statusDate, due, owner, level, row,currentProcessState[task].trip));
         tasks.push(createTask(process, task, 'Approved', statusDate, statusDate, due, owner, level, row,currentProcessState[task].trip));
       }
       else {
         // Is start date statusDate or some previous date?
         tasks.push(createTask(process, task, 'Approved', statusDate, statusDate, due, owner, level, row,currentProcessState[task].trip));
       }
     }
     break;

    default:
      console.log(permitNum + ": Unknown Review: " + process + ", task = " + task + ", status = " + status + ", date " + statusDate);
    //tasks.push(createTask(process, task, status, statusDate, statusDate, due, owner, level, row));

      break;
  }
}

const issuanceProcess = function (tasks, process, row, currentProcessState) {
  const task = row.Task, status = row.Status, statusDate = row['Status Date'];
  if (!('processStartDate' in currentProcessState)) { // First time here
    currentProcessState.processStartDate = statusDate; // This is the start of the whole process
    tasks.push(createTask(process, process, 'Start', statusDate, statusDate, null, '-', 0, row));
  }
  if (task == process && status == 'Issue') {
    currentProcessState.complete = true;
    tasks.push(createTask(process, task, status, currentProcessState.processStartDate, statusDate, null, '-', 0, row));
  }
}

const closeoutProcess = function (tasks, process, row, currentProcessState) {
  const task = row.Task, status = row.Status, statusDate = row['Status Date'];
  if (!('processStartDate' in currentProcessState)) { // First time here
    currentProcessState.processStartDate = statusDate; // This is the start of the whole process
    tasks.push(createTask(process, process, 'Start', statusDate, statusDate, null, '-', 0, row));
  }

  if (task == process && status == 'Complete') {
    currentProcessState.complete = true;
    tasks.push(createTask(process, task, status, currentProcessState.processStartDate, statusDate, null, '-', 0, row));
  }
  else if (task != process) {
    const locStatus = (status == 'NULL')?'Pending':status;
    let startDate = statusDate, endDate = statusDate;
    if (startDate == 'NULL') {
      startDate = currentProcessState.processStartDate;
      endDate = null;
    }
    tasks.push(createTask(process, task, locStatus, startDate, endDate, null, '-', 1, row));
  }
}

const wf_masterv4 = function (elements) {
  let currentState = {};
  let tasks = [];
  permitNum = elements[0].B1_ALT_ID;
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
            tasks.push(createTask(process, process, 'Start', currentProcessState.startDate, statusDate, null, '-', 0, row));
          }
          tasks.push(createTask(process, task, status, statusDate, statusDate, null, '-', 1, row));
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

  let tasks = [];

  if (elements[0].Workflow == 'MASTER V4') {
    tasks = wf_masterv4(elements);
  }
  else {
    console.log("Unknown workflow " + elements[0].Workflow);
  }

  outputPermit(tasks);
}

let init = 0;
let fPermits, fPermitsHistory, fSummaryByTrip, fSummaryByPermit;

const outputPermit = function (tasks) {
  if (init == 0) {
      fPermits = fs.openSync('t_permits.csv', 'w');
      fPermitsHistory = fs.openSync('t_permits_history.csv','w');

    fs.write(fPermitsHistory,
      'B1_ALT_ID,Id,Process,Task,Status,Trip,Start,End,Due Date,Owner,Level,Type,SubType,' +
      'Category,Application Date,Application Status,Application Status Date,Agency Code,' +
      'Comment\n');
    init = 1;
  }

  let r = tasks[0];
  let permit = {
    permit_id: r.B1_ALT_ID,
    type: r.type,
    subtype: r.subtype,
    category: r.category,
    app_date: r.appdate,
    app_status: r.appstatus,
    app_status_date: r.appstatusdate,
    trips: 0
  };
  let maxTrip = 0;
  let trips = [];
  tasks.forEach( (row, index) => {
    if (row.trip > maxTrip) {
      maxTrip = row.trip;
      trips[row.trip] = {
        start: row.start,
        end: null,
        due: row.due,
        tasks: [row]
      };
    }
    else if (row.trip > 0) {
      trips[row.trip].tasks.push(row);
    }
    let line = `${row.B1_ALT_ID},${index},${row.process},${row.task},${row.status},${row.trip},`;
    line += `${row.start},${row.end},${row.due},${row.owner},${row.level},${row.type},${row.subtype},`;
    line += `${row.category},${row.appdate},${row.appstatus},${row.appstatusdate},${row.agencycode},`;
    line += `${row.comment}\n`;
    fs.writeSync(fPermitsHistory, line);
    //console.log(line);
  });
  permit.trips = maxTrip;
  let doit = false;
  if (permit.permit_id == '16-10682') doit = true;
  if (maxTrip == 0) {
    console.log(permit.permit_id + "  - Max trip: " + maxTrip + ", appdate " + permit.app_date);
  }
  else {
    trips.forEach( (trip, index) => {
      const len = trip.tasks.length;
      trip.end = trip.tasks[len-1].end;
      const d1 = new Date(trip.start);
      const d2 = new Date(trip.end);
      const d3 = new Date(trip.due);
      let days = Utilities.workingDaysBetweenDates(d1, d2);
      let sla = Utilities.workingDaysBetweenDates(d1, d3);
      let custDays = 0;
      for (let i=0; i<len; ++i) {
        let tsk = trip.tasks[i];
        if (doit) {
          console.log("* " + tsk.task + "." + tsk.status + ":  " + trip.tasks[i].start + "  -  " + trip.tasks[i].end);
        }
        if (trip.tasks[i].owner == 'CUST') {
          custDays += Utilities.workingDaysBetweenDates(new Date(trip.tasks[i].start), new Date(trip.tasks[i].end));
        }
      }
      if (doit) {
        console.log(" " + permit.permit_id + "   trip " + index + ": " + days + " of " + sla + " - " + custDays + ", " + trip.start + " -- " + trip.end);
      }
    });
  }
}

/*
 * MAIN PROGRAM
 */

const processingMode = 'csv';
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
        tasks = wf_masterv4(elements);
      }
      else {
        console.log("Unknown workflow " + elements[0].Workflow);
      }

      outputPermit(tasks);
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
