# Debt Tracker — Eaton Family

A local debt snowball tracker with SQLite persistence.

## Requirements

- Node.js (v18 or later) — https://nodejs.org

## Setup (one time only)

```bash
cd debt-tracker
npm install
```

## Run

```bash
npm start
```

Then open http://localhost:3000 in any browser on this machine.

## Access from other devices on your network

Find your server's local IP address:
- Mac/Linux: run `ifconfig` or `ip addr` — look for something like 192.168.1.x
- Windows: run `ipconfig` — look for IPv4 Address

Then on your phone/tablet open: http://192.168.1.x:3000

## Data

All data is stored in `debt-tracker.db` (SQLite) in the same folder.
This file is your database — back it up if you want to be safe.

## Change the port

```bash
PORT=8080 npm start
```

## Stop

Ctrl+C in the terminal.
