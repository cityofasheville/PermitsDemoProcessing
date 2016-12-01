const Tabletop = require('tabletop');
const Utilities = require('./utilities.js');
const fs = require('fs');
var parse = require('csv-parse/lib/sync');

let permitNum = -1;
let doit = false;

const dlog = function (line) {
  if (doit) console.log(line);
}

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

const resetAllTasks = function (currentProcessState, statusDate, resetValue) {
  for (taskItem in currentProcessState) {
    if (taskItem != 'processStartDate' && taskItem != 'processRoundStartDate') {
      currentProcessState[taskItem].reset = resetValue;
      currentProcessState[taskItem].start = statusDate;
      if (currentProcessState[taskItem].previous) {
        currentProcessState[taskItem].previous.end = statusDate;
      }
      currentProcessState[taskItem].previous = null;
    }
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
      resetAllTasks(currentProcessState, statusDate, true);
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

/*
 * Each time through the review process is a "trip" and we need to compute SLAs for each trip separately.
 * Counting trips happens at two levels - overall process (which determines the trip number assigned to a
 * division when it first appears in the process) and the individual division, or task (which takes over the counting
 * for itself once it starts). The reason we need the 2 levels is that divisions can start a new trip without
 * anything happening to indicate it at the process level (i.e., no routing step). At the same time, it can
 * happen that a new division review starts late in the process (including after the "review process" finishes,
 * unfortunately), and needs to be assigned to a trip that gives it the right due date.
 *
 * The startNewTrip and currentTripNumber track trip numbers at the process level. The currentProcessState[task]
 * object tracks it for an individual task (division).
 */
let currentTripNumber = 0;
let maxTripNumber = 0;
let startNewTrip = true;
let mycount = 0;
const reviewProcess = function (tasks, process, row, currentProcessState) {
  const task = row.Task, status = row.Status;
  const statusDate = row['Status Date'], due = row['Due Date'];

  if (!('processStartDate' in currentProcessState)) { // First time here
    currentTripNumber = 0;
    maxTripNumber = 0;
    startNewTrip = true;
    mycount = 0;
    dlog("---------------Starting permit " + row.B1_ALT_ID + ", set currentTripNumber = 0 -------");
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
      if (task == 'Routing') {
        resetAllTasks(currentProcessState, statusDate, false);
        startNewTrip = true;
        dlog("Set currentTripNumber to " + currentTripNumber + " in routing step - status = " + status);
      }
      if (task == 'Review Process' && status == 'Complete') {
        startNewTrip = true;
        dlog("Set startNewTrip to true because review is complete");
        currentProcessState.complete = true;
        startDate = currentProcessState.processStartDate;
        currentProcessState.processRoundStartDate = null;
      }
    }
    tasks.push(createTask(process, task, status, startDate, statusDate, null, '-', specials[task], row));
    return;
  }
  if (startNewTrip) {
    dlog("NEWTRIP start - " + currentTripNumber + " - " + maxTripNumber);
    currentTripNumber = Math.max(currentTripNumber, maxTripNumber);
    ++currentTripNumber;
    maxTripNumber = currentTripNumber;
    startNewTrip = false;
    dlog("NEWTRIP - now the currentTripNumber is " + currentTripNumber);
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
      mode: 'init',
      modeDate: null,
      reset: false,
      trip: currentTripNumber,
      start: currentProcessState.processRoundStartDate?currentProcessState.processRoundStartDate:statusDate,
      previous: null,
      due: null
    };
    dlog("Initialized " + task + "." + status + " to trip " + currentTripNumber);
  }
  // Complete the previous step, if it exists.
  if (currentProcessState[task].previous) {
    currentProcessState[task].previous.end = statusDate;
    currentProcessState[task].previous = null;
  }
  // This takes care of the case when examiners skip routing
  if (terminator && !(currentProcessState[task].reset)) {
      currentProcessState[task].start = statusDate;
      currentProcessState[task].start = currentProcessState.processRoundStartDate?currentProcessState.processRoundStartDate:statusDate;
      dlog(" Have a terminator - start is now " + currentProcessState[task].start);

      dlog(task + ": Update task "+task+", status "+status + " -currentTripNumber now " + currentProcessState[task].trip);
  }

  let mode = currentProcessState[task].mode;
  let modeDate = currentProcessState[task].modeDate;
  if (modeDate && currentProcessState[task].start) {
    if (Utilities.compareDates(modeDate, currentProcessState[task].start) > 0) {
      currentProcessState[task].start = statusDate;
    }
  }
  dlog("  " + process + "."+task+'.'+status + ": " + statusDate + ", trip " + currentProcessState[task].trip + ", mode " + mode);

  switch (switchStatus) {
    case 'In Review':
      {
        if (mode == 'review') {
          // That's weird, just repeat it
        }
        else {
          // Don't need anything special with mode == 'init'other than Pending Review
          if (mode == 'hold' || mode == 'done') { // New trip
            currentProcessState[task].trip += 1;
          }
          tasks.push(createTask(process, task, 'Pending Review', currentProcessState[task].start, statusDate,
                     due, owner, level, row, currentProcessState[task].trip));
          currentProcessState[task].start = statusDate;
        }
        tasks.push(createTask(process, task, 'In Review', statusDate, null, due, owner, level, row,currentProcessState[task].trip));
        currentProcessState[task].previous = tasks[tasks.length-1];
        currentProcessState[task].mode = 'review';
        currentProcessState[task].modeDate = statusDate;
      }
      break;
    case 'Hold for Revision':
     {
       if (mode == 'hold') {
         // Weird, but don't do anything
       }
       else if (mode == 'init' || mode == 'done') { // We skipped some steps!
         dlog("Hold in the air! Mode = " + mode);
         if (mode == 'done') currentProcessState[task].trip += 1;
         tasks.push(createTask(process, task, 'Pending Review', currentProcessState[task].start, statusDate, due, owner, level,
            row, currentProcessState[task].trip));
         tasks.push(createTask(process, task, 'In Review', statusDate, statusDate, due, owner, level,
            row, currentProcessState[task].trip));
       }
       // If mode == 'review', all is normal
       tasks.push(createTask(process, task, 'Hold for Revision', statusDate, null, null, 'CUST', level,
          row,0));
       //currentProcessState[task].reset = true;
       currentProcessState[task].start = statusDate;
       currentProcessState[task].previous = tasks[tasks.length-1];
       currentProcessState[task].mode = 'hold';
       currentProcessState[task].modeDate = statusDate;
     }
     break;

    case 'NULL':
      {
        /*
         * Not sure what to do with these other than set them to "Pending Review". These don't really seem
         * real (at least in most cases), but they're red in Accela.
         */
        tasks.push(createTask(process, task, 'Pending Review', currentProcessState.processRoundStartDate, null, null, 'DSD', level, row,currentProcessState[task].trip));
        currentProcessState[task].reset = false;
        currentProcessState[task].start = currentProcessState.processRoundStartDate;
        currentProcessState[task].previous = tasks[tasks.length-1];
        currentProcessState[task].mode = 'review'; //??
        currentProcessState[task].modeDate = statusDate;
      }
      break;

    case 'TERMINATOR':
     {
       if (mode != 'review') {
         if (mode == 'done' || mode == 'hold') {
           currentProcessState[task].trip += 1;
           dlog("Actually incrementing trip " + currentProcessState[task].trip);
           currentProcessState[task].start = currentProcessState.processRoundStartDate;
           if (!currentProcessState[task].start) {
             currentProcessState[task].start = statusDate;
           }
           else if (modeDate && Utilities.compareDates(modeDate, currentProcessState[task].start) > 0) {
             currentProcessState[task].start = statusDate;
           }
           dlog("Mode " + mode + ", set start to " + currentProcessState[task].start);
         }
         dlog(" Unexpected terminator - doing pending and in review ")
         tasks.push(createTask(process, task, 'Pending Review', currentProcessState[task].start,
                    statusDate, due, owner, level, row,currentProcessState[task].trip));
         tasks.push(createTask(process, task, 'In Review', statusDate, statusDate, due, owner, level, row,currentProcessState[task].trip));
       }
       tasks.push(createTask(process, task, status, statusDate, statusDate, due, owner, level, row,currentProcessState[task].trip));
       currentProcessState[task].mode = 'done';
       currentProcessState[task].modeDate = statusDate;
     }
     break;

    default:
      console.log(permitNum + ": Unknown Review: " + process + ", task = " + task + ", status = " + status + ", date " + statusDate);
    //tasks.push(createTask(process, task, status, statusDate, statusDate, due, owner, level, row));

      break;
  }
  maxTripNumber = Math.max(currentTripNumber, maxTripNumber);
  maxTripNumber = Math.max(currentProcessState[task].trip, maxTripNumber);
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
    if (!row['Status Date'] || row['Status Date'].toLowerCase() == 'null') {
      row['Status Date'] = null;
    }
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
 
const SLA_Values = [2, 3, 10, 21, 30, 45, 90];
const SLA_Full_Names = [
  'Quick Touch - 3 Days',
  'Res. Waiver - 2 Days',
  'Residential - 10 Days',
  'Small Comm - 10 Days',
  'Std Level I Comm  - 21 Days',
  'Std Level II or III Comm - 45 Days',
  'Large Comm - 90 Days'];
const SLA_Short_Names = [
  'Quick Touch',
  'Res. Waiver',
  'Residential',
  'Small Comm',
  'Level I Comm',
  'Level II or III Comm',
  'Large Comm'];

const getSLA = function (n) {
  start = 999999;
  index = -1;
  SLA_Values.forEach( (val, idx) => {
    const diff = Math.abs(val - n);
    if (diff <= start) {
      index = idx;
      start = diff;
    }
  });
  return {
    days: SLA_Values[index],
    shortName: SLA_Short_Names[index],
    fullName: SLA_Full_Names[index],
  };
}
let init = 0;
let fPermits, fPermitsHistory, fTripsHistory;
let violationCountByTrip = 0;
let violationCountByPermit = 0;
let permitViolations = [];
let tripViolations = [];

const createViolationsEntry = function (fld1, fld2, fld3 = null, fld4 = null) {
  let r = {};
  r[fld1] = {};
  r[fld1][fld2]=null;
  if (fld3) {
    r[fld1][fld2]={};
    r[fld1][fld2][fld3] = null;
    if (fld4) {
      r[fld1][fld2][fld3] = {};
      r[fld1][fld2][fld3][fld4] = null;
    }
  }
  return r;
}

let DivisionIndex = {};

const outputPermit = function (tasks) {
  let line;
  if (init == 0) {
    DivisionIndex['Building Review'] = 0;
    DivisionIndex['Fire Review'] = 1;
    DivisionIndex['Zoning'] = 2;
    DivisionIndex['Addressing'] = 1;

    fPermits = fs.openSync('t_permits.csv', 'w');
    fPermitsHistory = fs.openSync('t_permits_history.csv','w');
    fTrips = fs.openSync('t_trips.csv','w');

    fs.write(fPermits,
      'permit_id,type,subtype,category,app_date,app_status,app_status_date,' +
      'trips,violation,violation_count,violation_days,sla,sla_name,building,fire,zoning,addressing\n');

    fs.write(fPermitsHistory,
      'permit_id,process,task,status,trip,start_date,end_date,due_date,owner,level,type,subtype,' +
      'category,app_date,app_status,app_status_date,agency_code,' +
      'comment\n');

    fs.write(fTrips,
      'permit_id,type,subtype,category,app_date,app_status,app_status_date,' +
      'trip,start_date,end_date,due_date,violation_days,sla,sla_name,division\n');

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
    trips: 0,
    violation: false,
    violationCount: 0,
    violationDays: 0,
    culprits:[0, 0, 0, 0]
  };

  let maxTrip = 0;
  let trips = [];
  tasks.forEach( (row, index) => {
    if (row.trip > 0) {
      if (row.trip > maxTrip) {
        dlog("Create a new trip " + row.trip);
        maxTrip = row.trip;
        trips[row.trip] = {};
      }
      if (!(row.task in trips[row.trip])) {
        let lstart = (row.start)?row.start:row.appdate;
        dlog(" Set trip due date " + row.due + " for task " + row.task);
        trips[row.trip][row.task] = {
          start: lstart,
          end: null,
          due: row.due,
          tasks: [row],
          violation: false,
          violationDays: 0
        };
      }
      else {
        trips[row.trip][row.task].tasks.push(row);
      }
    }
    dlog("Trip " + row.trip + ": start = " + row.start + ", end = " + row.end + ", due = " + row.due);
    line = `${row.B1_ALT_ID},${row.process},${row.task},${row.status},${row.trip},`;
    line += `${row.start},${row.end},${row.due},${row.owner},${row.level},${row.type},${row.subtype},`;
    line += `${row.category},${row.appdate},${row.appstatus},${row.appstatusdate},${row.agencycode},`;
    line += `${row.comment}\n`;
    fs.writeSync(fPermitsHistory, line);
  });
  permit.trips = maxTrip;
  let culpritDivisions = [false, false, false, false]; // Building,Fire,Zoning,Addressing
  let slaInfo = { days: -1, fullName: 'None', shortName: 'None' };
  let sla = -1;
  if (maxTrip > 0) {
    trips.forEach( (tripSet, index) => {
      for (let key in tripSet) {
        let trip = tripSet[key];
        dlog ("Working trip " + index + " for task " + key + ", due = " + trip.due);
        const len = trip.tasks.length;
        trip.end = trip.tasks[len-1].end;
        if (!trip.end) {
          let tmp = new Date();
          tmp.setHours(0,0,0,1);  // Start just after midnight
          trip.end = tmp.toISOString();
        }
        const d1 = trip.start?new Date(trip.start):null;
        const d2 = trip.end?new Date(trip.end):null;
        const d3 = trip.due?new Date(trip.due):null;
        let days = (d1&&d2)?Utilities.workingDaysBetweenDates(d1, d2):null;
        slaInfo = (d1&&d3)?getSLA(Utilities.workingDaysBetweenDates(d1, d3)):null;
        sla = (slaInfo)?slaInfo.days:null;
        trip.violation = false;
        trip.violationDays = 0;
        // MAYBE COMPUTE TIME SPENT IN PENDING VS REVIEW
        trip.pending = 0;
        trip.review = 0;
        if ((days && sla) && days > sla) {
          trip.violation = true;
          trip.violationDays = days - sla;
          permit.violation = true;
          permit.violationCount += 1;
          permit.violationDays += trip.violationDays;
          permit.culprits[DivisionIndex[key]] += 1;
        }

        // Output the trip
        if (!sla) {
          sla = -1;
          slaInfo = { days: -1, fullName: 'None', shortName: 'None' };
        }
        line = `${permit.permit_id},${permit.type},${permit.subtype},${permit.category},${permit.app_date},${permit.app_status},`;
        line += `${permit.app_status_date},${index},${trip.start},${trip.end},`;
        line += (trip.due)?`${trip.due},`:',';
        line += `${trip.violationDays},${sla},${slaInfo.shortName},${key}\n`;
        if (!permit.app_date) throw line;
        fs.writeSync(fTrips, line);

        if (trip.violation) {
          ++violationCountByTrip;
        }
        for (let i=0; i<len; ++i) {
          let tsk = trip.tasks[i];
          dlog("* " + tsk.task + "." + tsk.status + ":  " + trip.tasks[i].start + "  -  " + trip.tasks[i].end);
        }
      }
    });
  }
  if (permit.violation) {
    ++violationCountByPermit;
  }

  line = `${permit.permit_id},${permit.type},${permit.subtype},${permit.category},${permit.app_date},`;
  line += `${permit.app_status},${permit.app_status_date},${permit.trips},`;
  line += `${permit.violation},${permit.violationCount},${permit.violationDays},${sla},${slaInfo.shortName},`;
  line += `${permit.culprits.join(',')}\n`;
  fs.writeSync(fPermits, line);
}

/*
 * MAIN PROGRAM
 */

// if (row.B1_ALT_ID == '16-06472') doit = true;
// if (row.B1_ALT_ID == '16-06977') doit = true;
// if (row.B1_ALT_ID == '16-07337') doit = true;
// if (row.B1_ALT_ID == '16-07528') doit = true;
// if (row.B1_ALT_ID == '16-08738') doit = true;

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
  console.log("Done processing - total permits = " + count);
  console.log("Total permit violations: " + violationCountByPermit);
  console.log("Total violations: " + violationCountByTrip);

}
