#!/bin/bash
cd /home/philipp/pq_brain
node server.js >> /home/philipp/pq_brain/brain.log 2>&1 &
echo $! > /home/philipp/pq_brain/brain.pid
