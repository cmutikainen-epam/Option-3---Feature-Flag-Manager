# Option 3 - Feature Flag Manager

## Overview

Basic feature flag service.

- The Dashboard manages a list of feature flags — each has a `name` and an `enabled` property.
  - Unique names are enforced.
  - Toggle On/Off (Only if user has seen the latest version of the enabled state).
  - Delete a Feature Flag (An in-progress read will still see previous value).
- The Test Page provides a playground for interacting with SQLite MVCC transactions.
- Provides an endpoint that allows clients to query a feature flag by name and get a boolean back.

```console
npm install
npm run build
npm start
# serves the Dashboard on http://localhost:3001
# serves the Test Page http://localhost:3001/test
```

### Dashboard Page

![Dashboard Page](readme-images/dashboard-page.png)

### Test Page

![Test Page](readme-images/test-page.png)

You can select a flag from the selector to see its properties.

![Test Page Selector](readme-images/test-page-selector.png)

Once a flag is selected, two test buttons become available:

### Throttled Toggle Button

![Test Page Throttled Toggle](readme-images/throttled-toggle.png)

Clicking this button calls the same function called in the Dashboard when you toggle the switch.
However, a 30-second timeout is triggered AFTER the database is updated but BEFORE the clients are updated via websocket
If you open the Dashboard on another tab, and attempt to toggle the flag that is selected on the Test page, you will get a 409 CONFLICT error as the decision to trigger a DB Write was made without seeing the most up to date Read.
Eventually, when the timeout expires, you would see the update (and the button becomes active again)*

*Note: only the Feature Flag selected on the /test page is delayed, if you interact with additional flags on the Dashboard, it will trigger a normal, non-delayed refresh and we will see all updates before the process on /test page is complete

### Throttled Read Sequence

![Test Page Throttled Read Sequencez`](readme-images/throttled-toggle.png)

Clicking this button calls the same function that a client would call to check the value of a Feature Flag during an A/B test in production.
However, a 30-second timeout is triggered BEFORE the database is updated.
If you open the Dashboard on another tab, and delete the that is selected on the Test page, you will see the old value reported in the Test page because at the point when the Read was initiated, the flag still existed and we want to honour that request by showing the value from the previous version.

## Additional Commands

### Local development

```console
npm install
npm run dev
```

- Client Dashboard (Vite dev server): <http://localhost:5173>
- Client Test Page: <http://localhost:5173/test>
- API server: <http://localhost:3001> (requests to `/api/*` are proxied from the client)

### Reset Database

SQLite persists its state as a file called app.db. This command will clear that file and the other cache files.

```console
npm run reset-db
```

### Code Quality

```console
npm test
npm run typecheck
npm run lint
npm run format
```

### Run in Docker (single localhost URL)

```console
docker compose up --build   # then open http://localhost:3001.
```

To run without compose:

```console
docker build -t amx-takehome .
docker run -p 3001:3001 -v amx-data:/app/data amx-takehome # then open http://localhost:3001.
```

## Feature flags API

| Method   | Route                          | Body                 | Notes                                |
| -------- | ------------------------------ | -------------------- | ------------------------------------ |
| `GET`    | `/api/flags`                   | —                    | List all flags, newest first         |
| `GET`    | `/api/flags/check?name={name}` | —                    | Returns a boolean                    |
| `POST`   | `/api/flags`                   | `{ name, enabled? }` | Create a flag (defaults to disabled) |
| `PATCH`  | `/api/flags/:id`               | `{ enabled }`        | Toggle a flag;                       |
| `DELETE` | `/api/flags/:id`               |                      | Delete a flag                        |

## TODO

- effect.ts is great for strong type-safety and concurrency with tight error handling, consider moving the websocket and event code into effect.ts
  - If not, new versions of node.js do support Native websockets so we could lose the dependency on ws
- support row-level websocket updates in order to scale to larger sets of feature flags
- right now we are using effect.ts `Schema` for /shared/errors.ts but we should expand the use of schema validation to remove casts
