// One-shot script: set billing + shipping addresses on the 10 demo accounts.
const { sfQuery, sfUpdate } = require('./sf.js');

const ADDRESSES = [
  { street: '415 Mission St',          city: 'San Francisco', state: 'CA', zip: '94105' },
  { street: '1 Market St',             city: 'San Francisco', state: 'CA', zip: '94105' },
  { street: '1 California St',         city: 'San Francisco', state: 'CA', zip: '94111' },
  { street: '200 California St',       city: 'San Francisco', state: 'CA', zip: '94111' },
  { street: '425 Market St',           city: 'San Francisco', state: 'CA', zip: '94105' },
  { street: '1 Daly City Plaza',       city: 'Daly City',     state: 'CA', zip: '94015' },
  { street: '100 Bayhill Dr',          city: 'San Bruno',     state: 'CA', zip: '94066' },
  { street: '1 Hacker Way',            city: 'Menlo Park',    state: 'CA', zip: '94025' },
  { street: '1600 Amphitheatre Pkwy',  city: 'Mountain View', state: 'CA', zip: '94043' },
  { street: '3000 Hanover St',         city: 'Palo Alto',     state: 'CA', zip: '94304' },
];

async function main() {
  const result = sfQuery(
    "SELECT Id, Name FROM Account WHERE OwnerId = '005Hs00000Ie1mpIAB' AND Type != null AND SDO_MAPS_Days_Since_Last_Visit__c != null ORDER BY SDO_MAPS_Days_Since_Last_Visit__c DESC LIMIT 10"
  );
  const accounts = result.records;
  console.log(`Found ${accounts.length} accounts`);

  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i];
    const addr = ADDRESSES[i];
    await sfUpdate('Account', acct.Id, {
      BillingStreet:      addr.street,
      BillingCity:        addr.city,
      BillingState:       addr.state,
      BillingPostalCode:  addr.zip,
      ShippingStreet:     addr.street,
      ShippingCity:       addr.city,
      ShippingState:      addr.state,
      ShippingPostalCode: addr.zip,
    });
    console.log(`  [${i + 1}/10] ${acct.Name} → ${addr.street}, ${addr.city}`);
  }

  // Verify
  const check = sfQuery(
    "SELECT Id, Name, BillingStreet FROM Account WHERE OwnerId = '005Hs00000Ie1mpIAB' AND BillingStreet != null ORDER BY Name LIMIT 20"
  );
  console.log(`\nVerification — accounts with BillingStreet populated: ${check.records.length}`);
  check.records.forEach(r => console.log(`  ${r.Name}: ${r.BillingStreet}`));
}

main().catch(err => { console.error(err); process.exit(1); });
