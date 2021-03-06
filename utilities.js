
Utilities = {};

Utilities.compareDates = function (d1, d2) {
  if (d1 && d2) {
    t1 = new Date(d1), t2 = new Date(d2);
    return t1.getTime() - t2.getTime();
  }
  throw `compareDates called on null date: ${d1} vs ${d2}`;
}

Utilities.getDateAsNumber = function (d0) {
  let d = new Date(d0);
  let month = d.getMonth() + '';
  let day = d.getDate() + '';
  if (day.length == 1) day = '0'+day;
  if (month.length == 1) month = '0'+month;
  return parseInt(`${d.getFullYear()}${month}${day}`);
}

Utilities.workingDaysBetweenDates = function (startDate, endDate) {
  if (!startDate || !endDate) return 0;
    // Validate input
    if (endDate < startDate)
        return 0;

    // Calculate days between dates
    var millisecondsPerDay = 86400 * 1000; // Day in milliseconds
    startDate.setHours(0,0,0,1);  // Start just after midnight
    endDate.setHours(23,59,59,999);  // End just before midnight
    var diff = endDate - startDate;  // Milliseconds between datetime objects
    var days = Math.floor(diff / millisecondsPerDay);

    // Subtract two weekend days for every week in between
    var weeks = Math.floor(days / 7);
    days = days - (weeks * 2);

    // Handle special cases
    var startDay = startDate.getDay();
    var endDay = endDate.getDay();

    // Remove weekend not previously removed.
    if (startDay - endDay > 0)
        days = days - 2;

    // Remove start day if span starts on Sunday but ends before Saturday
    if (startDay == 0 && endDay != 6)
        days = days - 1

    // Remove end day if span ends on Saturday but starts after Sunday
    if (endDay == 6 && startDay != 0)
        days = days - 1

    return days;
}

Utilities.doit = function () {
  console.log("I am calling the doit function");
}

module.exports = Utilities;
