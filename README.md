# AuroraCraft

AI-powered Minecraft plugin development platform. Describe what you want and an AI agent writes the plugin code for you — supporting Java & Kotlin, Maven & Gradle, and multiple server software types.

## Features

- **AI Plugin Generation** — Chat with an AI coding agent (OpenCode) that writes, edits, and scaffolds Minecraft plugins
- **Multi-Model Support** — Choose from free AI models (MiniMax M2.5, Mimo V2 Flash, Nemotron 3 Super, GPT-5 Nano, Big Pickle)
- **Project Management** — Create, configure, and manage multiple plugin projects
- **Real-Time Streaming** — Live streaming of AI responses with thinking blocks, file operations, and progress tracking
- **Monaco Code Editor** — Built-in code editor with syntax highlighting and file tree navigation
- **Admin Panel** — User management, project oversight, and AI runtime configuration
- **Multi-User** — Role-based access control (admin / user)

## Tech Stack

| Layer     | Technology                                                  |
| --------- | ----------------------------------------------------------- |
| Frontend  | React 19, Vite 7, TailwindCSS 4, React Router, TanStack Query, Zustand, Monaco Editor |
| Backend   | Fastify 5, Drizzle ORM, PostgreSQL, WebSocket               |
| AI Bridge | OpenCode (open-source AI coding agent)                       |
| Process   | PM2 (process manager with auto-restart)                      |
| Language  | TypeScript (ES2024, strict mode)                             |

## Prerequisites

- **OS:** Debian 12 (Bookworm) or Ubuntu 24.04 (Noble)
- **RAM:** 2 GB minimum, 4 GB recommended
- **Root or sudo access**

---

## Installation

Run all commands as root or prefix with `sudo`.

### 1. System Packages

```bash
sudo apt update && sudo apt install -y curl ca-certificates build-essential git
```

### 2. Node.js 24

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify:

```bash
node -v   # v24.x.x
npm -v    # 11.x.x
```

### 3. PostgreSQL 18

```bash
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail https://www.postgresql.org/media/keys/ACCC4CF8.asc

. /etc/os-release
sudo sh -c "echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main' > /etc/apt/sources.list.d/pgdg.list"

sudo apt update
sudo apt install -y postgresql-18 postgresql-contrib-18
```

Start and enable:

```bash
sudo systemctl enable postgresql
sudo systemctl start postgresql
```

Verify:

```bash
sudo systemctl status postgresql
pg_isready
```

### 4. OpenCode

```bash
curl -fsSL https://raw.githubusercontent.com/opencode-ai/opencode/refs/heads/main/install | bash
```

Verify:

```bash
opencode --version
```

### 5. PM2

```bash
sudo npm install -g pm2
```

---

## Clone & Install

```bash
git clone https://github.com/YOUR_USERNAME/AuroraCraft.git
cd AuroraCraft
npm install
```

This installs dependencies for both `client/` and `server/` workspaces.

---

## Environment Configuration

```bash
cp .env.example .env
```

Edit `.env` and update at minimum the `SESSION_SECRET`:

```bash
nano .env
```

```env
# Database
DATABASE_URL=postgresql://auroracraft:auroracraft@localhost:5432/auroracraft

# Server
PORT=3000
HOST=0.0.0.0
NODE_ENV=development

# Session — CHANGE THIS to a random string (32+ characters)
SESSION_SECRET=your-random-secret-key-here

# Cookie domain — set to your domain in production
COOKIE_DOMAIN=localhost

# Client URL (for CORS)
CLIENT_URL=http://localhost:5173

# OpenCode URL (for AI agent)
OPENCODE_URL=http://localhost:4096
```

---

## Database Setup

### Create PostgreSQL Role & Database

```bash
sudo -u postgres psql <<SQL
CREATE ROLE auroracraft WITH LOGIN PASSWORD 'auroracraft';
CREATE DATABASE auroracraft OWNER auroracraft;
GRANT ALL PRIVILEGES ON DATABASE auroracraft TO auroracraft;
SQL
```

Verify the connection:

```bash
psql postgresql://auroracraft:auroracraft@localhost:5432/auroracraft -c 'SELECT 1'
```

### Run Migrations

```bash
npm run db:migrate
```

### Seed the Database

```bash
npm run db:seed
```

This creates the default **admin user**:

| Field    | Value              |
| -------- | ------------------ |
| Username | `admin`            |
| Password | `admin123`         |
| Email    | admin@auroracraft.dev |
| Role     | admin              |

> **Change the admin password** after your first login.

> **AI Models** are built into the application and appear automatically on the Admin → AI Runtime page. No additional model configuration is needed — OpenCode's free models (MiniMax M2.5, Mimo V2 Flash, Nemotron 3 Super, GPT-5 Nano, Big Pickle) are available out of the box once OpenCode is running.

---

## First Start (Manual)

Start each service individually to verify everything works.

**Terminal 1 — OpenCode:**

```bash
cd AuroraCraft
opencode serve
```

You should see OpenCode listening on `http://127.0.0.1:4096`.

**Terminal 2 — Backend:**

```bash
cd AuroraCraft
npm run dev:server
```

The Fastify server starts on `http://0.0.0.0:3000`.

**Terminal 3 — Frontend:**

```bash
cd AuroraCraft
npm run dev:client
```

Vite dev server starts on `http://localhost:5173`.

Open `http://localhost:5173` in your browser, log in with `admin` / `admin123`, and verify:

- ✅ Login works
- ✅ You can create a project
- ✅ Admin → AI Runtime shows OpenCode as **Active** with available models
- ✅ AI chat responds to prompts

Once verified, stop all three with `Ctrl+C` and proceed to PM2 setup.

---

## Production Setup with PM2

### Create Logs Directory

```bash
mkdir -p logs
```

### Start All Services

```bash
pm2 start ecosystem.config.cjs
```

Verify:

```bash
pm2 list
pm2 logs --lines 20
```

All three services should show `online`:

| Name                  | Port |
| --------------------- | ---- |
| auroracraft-server    | 3000 |
| auroracraft-client    | 5173 |
| auroracraft-opencode  | 4096 |

### Auto-Start on Boot

#### 1. PM2 Startup Hook

```bash
pm2 startup
```

PM2 will print a command to run with `sudo` — copy and execute it. Then save the process list:

```bash
pm2 save
```

#### 2. PostgreSQL + PM2 Boot Script

Since PostgreSQL must start before PM2 processes, use the included boot script:

```bash
chmod +x start-all.sh
```

Add it to crontab:

```bash
crontab -e
```

Add this line:

```
@reboot /path/to/AuroraCraft/start-all.sh >> /path/to/AuroraCraft/logs/boot.log 2>&1
```

Replace `/path/to/AuroraCraft` with the actual absolute path (e.g. `/home/user/AuroraCraft`).

This script starts PostgreSQL first, waits for it to be ready, then starts all PM2 processes.

---

## PM2 Commands Reference

```bash
pm2 list                        # Show all processes
pm2 logs                        # Tail all logs
pm2 logs auroracraft-server     # Tail server logs
pm2 restart all                 # Restart all
pm2 restart auroracraft-server  # Restart one service
pm2 stop all                    # Stop all
pm2 delete all                  # Remove all from PM2
pm2 start ecosystem.config.cjs  # Start from config
pm2 save                        # Save current process list
pm2 resurrect                   # Restore saved process list
pm2 monit                       # Real-time monitoring dashboard
```

---

## Project Structure

```
AuroraCraft/
├── client/                   # React frontend (Vite)
│   ├── src/
│   │   ├── components/       # Shared UI components
│   │   ├── pages/            # Route pages (dashboard, admin, projects)
│   │   ├── stores/           # Zustand state stores
│   │   ├── types/            # TypeScript types & AI model definitions
│   │   └── ...
│   ├── package.json
│   └── vite.config.ts
├── server/                   # Fastify backend
│   ├── drizzle/              # SQL migration files
│   ├── src/
│   │   ├── agents/           # AI agent execution logic
│   │   ├── bridges/          # OpenCode bridge (SSE streaming)
│   │   ├── db/               # Database connection, schema, migrations, seed
│   │   ├── middleware/       # Authentication middleware
│   │   ├── plugins/          # Fastify plugins (CORS, cookies, WebSocket)
│   │   ├── routes/           # API routes (auth, projects, agents, admin)
│   │   └── index.ts          # Server entry point
│   ├── drizzle.config.ts
│   └── package.json
├── ecosystem.config.cjs      # PM2 process configuration
├── start-all.sh              # Boot startup script (PostgreSQL + PM2)
├── .env.example              # Environment variable template
├── package.json              # Root workspace configuration
└── tsconfig.base.json        # Shared TypeScript configuration
```

---

## License

MIT
