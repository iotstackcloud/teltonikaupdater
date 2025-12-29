# Teltonika Firmware Updater

Web-basierte Anwendung zur Verwaltung und Durchfuehrung von Massen-Firmware-Updates auf Teltonika Routern.

## Features

- **Excel-Import**: Router-Listen aus Excel importieren (Geraetename, IP-Adresse, User, Passwort)
- **Globale Credentials**: Zentrale Zugangsdaten fuer alle Router ohne individuelle Credentials
- **Firmware-Check**: Automatische Pruefung des Firmware-Status aller Router via SSH
- **Batch-Updates**: Updates in konfigurierbaren Batches (5, 10, 25, 100 Router)
- **10 Minuten Pause**: Automatische Wartezeit zwischen Batches zur Netzwerkstabilisierung
- **SQLite-Datenbank**: Persistente Speicherung aller Router und Update-Historie
- **Fehler-Tracking**: Dokumentation von Fehlern (nicht erreichbar, Update fehlgeschlagen, etc.)
- **Update-Historie**: Vollstaendige Protokollierung mit Firmware vorher/nachher und Zeitstempel

## Voraussetzungen

- Node.js 18+
- SSH-Zugang zu den Teltonika Routern (Port 22)
- Teltonika Router mit RutOS (getestet mit RUT955, RUT950, RUT240, etc.)

## Installation

```bash
# Repository klonen
git clone git@github.com:iotstackcloud/teltonikaupdater.git
cd teltonikaupdater

# Dependencies installieren
npm install

# Development Server starten
npm run dev
```

Die Anwendung ist dann unter http://localhost:3000 erreichbar.

## Verwendung

### 1. Globale Credentials konfigurieren

Unter **Einstellungen** koennen globale SSH-Zugangsdaten hinterlegt werden, die fuer alle Router ohne individuelle Credentials verwendet werden.

### 2. Router importieren

Excel-Datei mit folgender Struktur vorbereiten:

| Geraetename | IP-Adresse | User | Passwort |
|-------------|------------|------|----------|
| Router001   | 10.0.1.1   |      |          |
| Router002   | 10.0.1.2   | root | secret   |

- **Geraetename**: Eindeutiger Name des Routers
- **IP-Adresse**: IP-Adresse des Routers
- **User**: Optional - SSH-Benutzername (Standard: globale Credentials)
- **Passwort**: Optional - SSH-Passwort (Standard: globale Credentials)

### 3. Firmware-Status pruefen

Mit **"Alle pruefen"** wird der aktuelle Firmware-Stand und verfuegbare Updates fuer alle Router ermittelt.

### 4. Updates durchfuehren

1. Batch-Groesse waehlen (5, 10, 25 oder 100)
2. **"Updates starten"** klicken
3. Die Anwendung aktualisiert Router in Batches mit 10 Minuten Pause dazwischen
4. Fortschritt wird live im Dashboard angezeigt

## API Endpoints

| Endpoint | Methode | Beschreibung |
|----------|---------|--------------|
| `/api/routers` | GET | Alle Router abrufen |
| `/api/routers` | DELETE | Alle Router loeschen |
| `/api/routers/check` | POST | Firmware-Status pruefen |
| `/api/import` | POST | Excel-Import |
| `/api/settings` | GET/POST | Globale Credentials |
| `/api/update` | GET/POST/DELETE | Batch-Updates verwalten |
| `/api/history` | GET | Update-Historie |

## Technologie-Stack

- **Frontend**: Next.js 16, React, Tailwind CSS
- **Backend**: Next.js API Routes
- **Datenbank**: SQLite (better-sqlite3)
- **SSH**: ssh2 Library

## Projektstruktur

```
src/
├── app/
│   ├── api/
│   │   ├── import/route.ts       # Excel-Import
│   │   ├── routers/
│   │   │   ├── route.ts          # Router CRUD
│   │   │   └── check/route.ts    # Firmware-Check
│   │   ├── settings/route.ts     # Credentials
│   │   ├── update/route.ts       # Batch-Updates
│   │   └── history/route.ts      # Historie
│   └── page.tsx                  # Dashboard UI
└── lib/
    ├── db.ts                     # SQLite Schema & Queries
    └── ssh-service.ts            # SSH Kommunikation
```

## Datenbank-Schema

### routers
- `id`: UUID
- `device_name`: Geraetename
- `ip_address`: IP-Adresse
- `username`: SSH User
- `password`: SSH Passwort
- `current_firmware`: Aktuelle Firmware
- `available_firmware`: Verfuegbare Firmware
- `status`: unknown | up_to_date | update_available | updating | unreachable | error
- `last_check`: Letzter Check-Zeitpunkt

### update_history
- `id`: UUID
- `router_id`: Referenz zum Router
- `firmware_before`: Firmware vor Update
- `firmware_after`: Firmware nach Update
- `status`: running | success | failed
- `error_message`: Fehlermeldung
- `started_at`: Start-Zeitpunkt
- `completed_at`: Ende-Zeitpunkt

## Lizenz

MIT
