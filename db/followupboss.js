const axios = require('axios');

const getAuthHeader = () => {
  const key = process.env.FUB_API_KEY || '';
  const encoded = Buffer.from(key + ':').toString('base64');
  return 'Basic ' + encoded;
};

const fubClient = axios.create({
  baseURL: 'https://api.followupboss.com/v1',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': getAuthHeader()
  }
});

// People (Leads)
async function getPerson(personId) {
  const { data } = await fubClient.get(`/people/${personId}`);
  return data;
}

async function getRecentPeople({ limit = 50, offset = 0 } = {}) {
  const { data } = await fubClient.get('/people', {
    params: { limit, offset, sort: '-created' }
  });
  return data.people || [];
}

// Calls
async function getCall(callId) {
  const { data } = await fubClient.get(`/calls/${callId}`);
  return data;
}

async function getCallsForPerson(personId) {
  const { data } = await fubClient.get('/calls', {
    params: { personId, limit: 100 }
  });
  return data.calls || [];
}

async function getRecentCalls({ limit = 100, offset = 0 } = {}) {
  const { data } = await fubClient.get('/calls', {
    params: { limit, offset, sort: '-created' }
  });
  return data.calls || [];
}

// Users (Reps)
async function getUsers() {
  const { data } = await fubClient.get('/users');
  return data.users || [];
}

async function getUser(userId) {
  const { data } = await fubClient.get(`/users/${userId}`);
  return data;
}

// Activity feed (for idle tracking)
async function getActivityForUser(userId, { since } = {}) {
  const params = { userId, limit: 200 };
  if (since) params.since = since;
  const { data } = await fubClient.get('/events', { params });
  return data.events || [];
}

module.exports = {
  getPerson,
  getRecentPeople,
  getCall,
  getCallsForPerson,
  getRecentCalls,
  getUsers,
  getUser,
  getActivityForUser
};
