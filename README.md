# DocSearch (simple version)

Find doctors on a map, book an appointment, get a PDF ticket with a token number.
Doctors register on the site and an admin approves them before patients can see them.

**The whole project is 4 files:**

| File | What it is |
|---|---|
| `server.js` | The entire backend (Express): data saving, login, admin approval, booking rules |
| `public/index.html` | The entire frontend: map, search, booking, PDF ticket, doctor dashboard, admin page |
| `package.json` | List of libraries to install |
| `README.md` | This file |

## Run it

You need [Node.js](https://nodejs.org) 18 or newer. In the VS Code terminal (run these one at a time):

```
npm install
npm start
```

Open **http://localhost:3000**. No second terminal, no build step: one server serves both the API and the page.

Try it: search **Kochi** or **Bengaluru** to see demo doctors.
Admin login (local testing only): `admin@docsearch.local` / `admin123`, reached with the small "Admin" link.

## How it works (the 5-minute explanation)

1. **Patient** types a city. The browser turns it into coordinates (OpenStreetMap Nominatim), the map flies there, and the server returns *approved* doctors within 25 km.
2. **Click a marker** to see the doctor's department, bio, schedule and clinic.
3. **Book**: pick a date. The server says which slots are taken and how many bookings are left that day. Taken slots are greyed out, and a full day blocks booking.
4. **Ticket**: the server gives the booking a token number (the day's booking count + 1), and the browser makes the PDF ticket (jsPDF) and downloads it.
5. **Doctor** registers (`pending`), then sets clinic, schedule and a **daily appointment limit** in their dashboard, where every booking made with them appears.
6. **Admin** sees pending doctors and clicks Approve or Reject. Only approved doctors show on the map.

## Where each feature lives

| Feature | Where |
|---|---|
| Map, search, doctor popup | `index.html` sections 2-3 |
| Booking screen + live availability | `index.html` section 4, `GET /api/doctors/:id/availability` in `server.js` |
| PDF ticket | `index.html` section 5 (`makePdf`) |
| Doctor register / login / dashboard | `index.html` sections 6-7, "Doctor routes" in `server.js` |
| Admin approval | `index.html` section 8, "Admin routes" in `server.js` |
| Daily limit + double-booking checks | `POST /api/appointments` in `server.js` |
| Saving data | `save()` in `server.js` writes `db.json` after every change |

## Safety features included

- Passwords hashed with bcrypt; login tokens (JWT) expire after 7 days
- Every input re-validated on the server (the browser's checks are only for convenience)
- Rate limits on login, registration and booking; security headers (helmet); 50 KB request cap
- All user text is escaped before display, so nobody can inject HTML/scripts through a name or bio
- Patients never receive a doctor's email or password hash
- Booking only accepts times that really are in the doctor's schedule, never in the past
- In production the server **refuses to start** with the default secret/admin password

## Before putting it on the internet

Set these environment variables on your host: `NODE_ENV=production`, `JWT_SECRET` (long random text), `ADMIN_EMAIL`, `ADMIN_PASSWORD`. Use a host with a **persistent disk**, or `db.json` is lost on each deploy (`DB_FILE` can point it at the disk).

**Honest limitations**, which this small version does not solve:

- `db.json` is a file, not a database. Fine for a demo or small pilot; use PostgreSQL before real traffic or more than one server.
- Nothing proves a doctor is real. The admin decides by reading the text they typed. Add license/ID checks before calling anyone "verified".
- There are no patient accounts, so patients can't cancel or view bookings, and anyone can book under any name.
- Login tokens are kept in the browser's `localStorage` (httpOnly cookies are stricter).
- No automated test suite and no error-monitoring service.
- The page loads Leaflet and jsPDF from public CDNs, so it needs internet access.
