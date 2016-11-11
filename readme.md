# DSD Permit Processing Script

This is a script to process permit records from [this Google sheet](https://docs.google.com/spreadsheets/d/1TR3v7jKfw1as8RuXrzvDqwoQdrOltMreqlqwJnxwWDk/edit#gid=0).

### Usage

Clone this repository then run:

````
npm install
node index.js [outputFile]
````

The script will write to _stdout_ if no file name is given. Set the _target_sheet_ variable at the top of the script to pick different sub-sheets in the Google sheet.
