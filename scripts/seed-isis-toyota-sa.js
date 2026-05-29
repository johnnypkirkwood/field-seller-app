// One-shot: create a test ServiceAppointment for the Bob Isis demo flow.
// Re-runnable: skips if a non-Completed SA already exists for the account.

const { sfCreate, sfQuery } = require('../sf');

const ACCOUNT_ID  = '001Hs00005vxBCUIA2';   // Isis Toyota
const CONTACT_ID  = '003Hs00007YoOQqIAN';   // Bob Isis
const REP_USER_ID = '005Hs00000Ie1mpIAB';
const TERRITORY_ID = '0HhHs000001UUGoKAO';

(async () => {
  const existing = sfQuery(`
    SELECT Id, Status FROM ServiceAppointment
    WHERE ParentRecordId = '${ACCOUNT_ID}' AND Status != 'Completed'
    ORDER BY CreatedDate DESC LIMIT 1
  `);
  if (existing.records.length) {
    console.log(`SKIP — existing SA: ${existing.records[0].Id} (${existing.records[0].Status})`);
    return;
  }

  // WorkType lookup
  const wt = sfQuery(`SELECT Id FROM WorkType WHERE Name = 'Sales Visit' LIMIT 1`);
  const workTypeId = wt.records[0]?.Id;
  if (!workTypeId) throw new Error('Sales Visit WorkType not found');

  const now = new Date();
  const earliest = now.toISOString();
  const due = new Date(now.toISOString().slice(0, 10) + 'T17:00:00-07:00').toISOString();

  const r = await sfCreate('ServiceAppointment', {
    ParentRecordId:     ACCOUNT_ID,
    ContactId:          CONTACT_ID,
    Subject:            'Sales visit — Isis Toyota',
    WorkTypeId:         workTypeId,
    ServiceTerritoryId: TERRITORY_ID,
    EarliestStartTime:  earliest,
    DueDate:            due,
    Street:             '1500 California Dr',
    City:               'Burlingame',
    State:              'CA',
    PostalCode:         '94010',
  });
  console.log(`OK — SA created: ${r.id}`);
  console.log(`Use this id for the curl test: ${r.id}`);
})();
