# FlyRank Usage Metering & Billing Engine

Backend service for FlyRank usage metering and billing infrastructure.

## Prerequisites

- Node.js (v18+)
- Docker & Docker Compose

## Quick Start

### 1. PostgreSQL Database Setup

To start the PostgreSQL database container using Docker Compose:

```bash
docker compose up -d
```

To stop the PostgreSQL container:

```bash
docker compose down
```

To view database logs:

```bash
docker compose logs -f postgres
```

### 2. Database Migrations

To apply the database schema to PostgreSQL:

```bash
npm run db:migrate
```

### 3. Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

### 4. Application Setup

Install dependencies:

```bash
npm install
```

Start the application in development mode:

```bash
npm run dev
```

Start the application in production mode:

```bash
npm start
```

## API Endpoints

- `GET /` - Health check / Engine status
