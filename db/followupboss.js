const axios = require('axios');

const fubClient = axios.create({
  baseURL: 'https://api.followupboss.com/v1',
  auth: {
    username: process.env.FUB_API_KEY,
    password: ''
  },
  headers: {
    'Content-Type': 'application/json',
    'X-System': 'REI-Sales-AI',
    'X-System-Key': 'a5c50b177fcb97980fb3201d65b46824'
  }
});

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

async function getUsers() {
  const { data } = await fubClient.get('/users');
  return data.users || [];
}

async function getUser(userId) {
  const { data } = await fubClient.get(`/users/${userId}`);
  return data;
}

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
https://rei-sales-backend-production.up.railway.app/setup/seed-reps
