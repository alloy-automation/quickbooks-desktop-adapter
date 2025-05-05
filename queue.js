const fs = require('fs');
const path = require('path');

const QUEUE_FILE = path.join(__dirname, 'queue.json');

function initQueue() {
  if (!fs.existsSync(QUEUE_FILE)) {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify([]));
  }
}

function addToQueue(requestXML) {
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE));
  queue.push(requestXML);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

function popFromQueue() {
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE));
  if (queue.length === 0) return null;
  const nextRequest = queue.shift();
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  return nextRequest;
}

function peekQueue() {
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE));
  return queue[0] || null;
}

function clearQueue() {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify([]));
}

module.exports = { initQueue, addToQueue, popFromQueue, peekQueue, clearQueue };
