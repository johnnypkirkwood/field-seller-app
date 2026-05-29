// Salesforce helper — shells out to `sf` CLI for read queries;
// uses jsforce REST for writes (avoids shell-escaping apostrophes entirely).
const { execSync } = require('child_process');
const jsforce = require('jsforce');

const SF_ALIAS = process.env.SF_ORG_ALIAS || 'fielddev';

// Cached connection — avoid shelling out to `sf` on every write.
// Invalidated on INVALID_SESSION_ID and re-fetched once.
let cachedConn = null;

function getSfConn() {
  if (cachedConn) return cachedConn;
  const tokenRaw = execSync(
    `sf org auth show-access-token --target-org ${SF_ALIAS} --no-prompt --json 2>/dev/null`,
    { encoding: 'utf8' }
  );
  const displayRaw = execSync(
    `sf org display --target-org ${SF_ALIAS} --json 2>/dev/null`,
    { encoding: 'utf8' }
  );
  const accessToken = JSON.parse(tokenRaw).result.accessToken;
  const instanceUrl = JSON.parse(displayRaw).result.instanceUrl;
  cachedConn = new jsforce.Connection({ accessToken, instanceUrl });
  return cachedConn;
}

function isExpiredSession(err) {
  const code = err?.errorCode || err?.name;
  return code === 'INVALID_SESSION_ID';
}

async function withConnRetry(fn) {
  try {
    return await fn(getSfConn());
  } catch (err) {
    if (!isExpiredSession(err)) throw err;
    cachedConn = null;
    return await fn(getSfConn());
  }
}

function sfQuery(soql) {
  const escaped = soql.replace(/"/g, '\\"');
  const raw = execSync(
    `sf data query --query "${escaped}" --target-org ${SF_ALIAS} --json 2>/dev/null`,
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  const parsed = JSON.parse(raw);
  if (parsed.status !== 0) throw new Error(parsed.message || 'SOQL query failed');
  return parsed.result;
}

async function sfCreate(sobject, record) {
  return withConnRetry(async (conn) => {
    const result = await conn.sobject(sobject).create(record);
    if (!result.success) {
      const errs = (result.errors || []).map(e => e.message).join('; ');
      throw new Error(`Create ${sobject} failed: ${errs}`);
    }
    return result;
  });
}

async function sfUpdate(sobject, id, record) {
  return withConnRetry(async (conn) => {
    const result = await conn.sobject(sobject).update({ Id: id, ...record });
    if (!result.success) {
      const errs = (result.errors || []).map(e => e.message).join('; ');
      throw new Error(`Update ${sobject} failed: ${errs}`);
    }
    return result;
  });
}

module.exports = { sfQuery, sfCreate, sfUpdate };
