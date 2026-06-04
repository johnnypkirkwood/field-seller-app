// One-shot seed for the Verde demo (M9.2).
// Creates: Verde Account, Bob Hodges (CEO) Contact, Bob Miller (Business
// Analyst) Contact, "Verde - Cloud Security Monitoring Upgrade" Opportunity.
// Reuses the existing "June 17th Phillies Executive Outing" Campaign if
// already seeded (otherwise creates it).
//
// Two Bobs is intentional — the demo's punchline is the agent correctly
// resolving "Bob at Verde, sounds like an exec" to Hodges (CEO) over
// Miller (Business Analyst).
//
// Safe to re-run: each create is guarded by an existence check.

const { sfCreate, sfQuery } = require('../sf');

const REP_USER_ID = '005Hs00000Ie1mpIAB';

async function findOne(soql) {
  const r = sfQuery(soql);
  return r.records[0] || null;
}

async function ensureAccount() {
  const existing = await findOne(
    `SELECT Id, Name FROM Account WHERE Name = 'Verde' LIMIT 1`
  );
  if (existing) {
    console.log(`SKIP Account     Verde already exists (${existing.Id})`);
    return existing.Id;
  }
  const res = await sfCreate('Account', {
    Name: 'Verde',
    OwnerId: REP_USER_ID,
    Phone: '(415) 555-0188',
    Website: 'https://verde.example',
    Industry: 'Technology',
    BillingStreet: '450 Sansome St',
    BillingCity: 'San Francisco',
    BillingState: 'CA',
    BillingPostalCode: '94111',
    BillingCountry: 'USA',
    ShippingStreet: '450 Sansome St',
    ShippingCity: 'San Francisco',
    ShippingState: 'CA',
    ShippingPostalCode: '94111',
    ShippingCountry: 'USA',
  });
  console.log(`OK   Account     Verde → ${res.id}`);
  return res.id;
}

async function ensureContactHodges(accountId) {
  const existing = await findOne(
    `SELECT Id, FirstName, LastName, AccountId FROM Contact
       WHERE FirstName = 'Bob' AND LastName = 'Hodges'
         AND AccountId = '${accountId}' LIMIT 1`
  );
  if (existing) {
    console.log(`SKIP Contact     Bob Hodges already exists (${existing.Id})`);
    return existing.Id;
  }
  const res = await sfCreate('Contact', {
    FirstName: 'Bob',
    LastName: 'Hodges',
    AccountId: accountId,
    Title: 'CEO',
    Email: 'bob.hodges@verde.example',
    Phone: '(415) 555-0189',
    MailingStreet: '450 Sansome St',
    MailingCity: 'San Francisco',
    MailingState: 'CA',
    MailingPostalCode: '94111',
    MailingCountry: 'USA',
  });
  console.log(`OK   Contact     Bob Hodges (CEO) → ${res.id}`);
  return res.id;
}

async function ensureContactMiller(accountId) {
  const existing = await findOne(
    `SELECT Id, FirstName, LastName, AccountId FROM Contact
       WHERE FirstName = 'Bob' AND LastName = 'Miller'
         AND AccountId = '${accountId}' LIMIT 1`
  );
  if (existing) {
    console.log(`SKIP Contact     Bob Miller already exists (${existing.Id})`);
    return existing.Id;
  }
  const res = await sfCreate('Contact', {
    FirstName: 'Bob',
    LastName: 'Miller',
    AccountId: accountId,
    Title: 'Business Analyst',
    Email: 'bob.miller@verde.example',
    Phone: '(415) 555-0190',
    MailingStreet: '450 Sansome St',
    MailingCity: 'San Francisco',
    MailingState: 'CA',
    MailingPostalCode: '94111',
    MailingCountry: 'USA',
  });
  console.log(`OK   Contact     Bob Miller (Business Analyst) → ${res.id}`);
  return res.id;
}

async function ensureOpportunity(accountId) {
  const oppName = 'Verde - Cloud Security Monitoring Upgrade';
  const existing = await findOne(
    `SELECT Id, Name, CloseDate, StageName FROM Opportunity
       WHERE AccountId = '${accountId}' AND Name = '${oppName}' LIMIT 1`
  );
  if (existing) {
    console.log(`SKIP Opportunity ${oppName} already exists (${existing.Id})`);
    return existing.Id;
  }
  const res = await sfCreate('Opportunity', {
    Name: oppName,
    AccountId: accountId,
    OwnerId: REP_USER_ID,
    StageName: 'Negotiation',
    Amount: 85000,
    CloseDate: '2026-09-30',
    Description: 'Cloud security monitoring platform upgrade for Verde. Bob Hodges (CEO) sponsoring; Bob Miller running point on technical eval.',
  });
  console.log(`OK   Opportunity ${oppName} → ${res.id}`);
  return res.id;
}

async function ensureCampaign() {
  // The "June 17th Phillies Executive Outing" campaign was seeded by
  // seed-bob-isis-demo.js. Re-detect and skip if present; create if not.
  const existing = await findOne(
    `SELECT Id, Name FROM Campaign WHERE Name = 'June 17th Phillies Executive Outing' LIMIT 1`
  );
  if (existing) {
    console.log(`SKIP Campaign    Phillies Executive Outing already exists (${existing.Id})`);
    return existing.Id;
  }
  const res = await sfCreate('Campaign', {
    Name: 'June 17th Phillies Executive Outing',
    Type: 'Conference',
    Status: 'In Progress',
    IsActive: true,
    StartDate: '2026-06-17',
    EndDate: '2026-06-17',
    Description: 'Executive hospitality outing at Phillies vs Giants, Oracle Park.',
  });
  console.log(`OK   Campaign    Phillies Executive Outing → ${res.id}`);
  return res.id;
}

(async () => {
  try {
    const accountId   = await ensureAccount();
    const hodgesId    = await ensureContactHodges(accountId);
    const millerId    = await ensureContactMiller(accountId);
    const oppId       = await ensureOpportunity(accountId);
    const campaignId  = await ensureCampaign();

    console.log('\n--- verification ---');
    const account = sfQuery(
      `SELECT Id, Name, BillingCity FROM Account WHERE Id = '${accountId}'`
    );
    console.log('Account:    ', account.records[0]);

    const contacts = sfQuery(
      `SELECT Id, FirstName, LastName, Title, Account.Name
         FROM Contact WHERE AccountId = '${accountId}'
         ORDER BY LastName ASC`
    );
    console.log('Contacts:   ', contacts.records);

    const opp = sfQuery(
      `SELECT Id, Name, StageName, Amount, CloseDate, Account.Name
         FROM Opportunity WHERE Id = '${oppId}'`
    );
    console.log('Opportunity:', opp.records[0]);

    const campaign = sfQuery(
      `SELECT Id, Name, Type, Status, IsActive, StartDate FROM Campaign WHERE Id = '${campaignId}'`
    );
    console.log('Campaign:   ', campaign.records[0]);

    console.log('\nDone.');
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
  }
})();
