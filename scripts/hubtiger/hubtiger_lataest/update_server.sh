#!/bin/bash

# --- RIDEAI HUBTIGER PROXY MASTER RESTART SCRIPT ---
PORT=8095
LOG_FILE="proxy_logs.txt"

echo "------------------------------------------------"
echo "🚀 RIDEAI: Stopping any existing server..."
echo "------------------------------------------------"

# 1. Kill any existing process on port 8095
PID=$(lsof -t -i:$PORT)
if [ ! -z "$PID" ]; then
    echo "⚠️ Killing process $PID on port $PORT..."
    kill -9 $PID
    sleep 1
fi

# 2. Cleanup broad node instances of this server
pkill -f "node server.js" 2>/dev/null

echo "🧹 Cleaning logs..."
rm -f $LOG_FILE
touch $LOG_FILE

# 3. Start the Server in the background
echo "✨ Starting RideAI Proxy (node server.js)..."
nohup node server.js >> $LOG_FILE 2>&1 &
SERVER_PID=$!

sleep 2

# 4. Status Check
if ps -p $SERVER_PID > /dev/null; then
   echo "✅ Server LIVE (PID: $SERVER_PID)."
   echo "🌍 Dashboard: http://agents.rideai.com.au:$PORT"
   echo "------------------------------------------------"
   echo "👀 TAILING LOGS (Ctrl+C to stop viewing):"
   tail -f $LOG_FILE
else
   echo "❌ Server FAILED to start. Check proxy_logs.txt"
   cat $LOG_FILE
   exit 1
fi