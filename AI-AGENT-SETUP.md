# Setup für KI-Agenten

Du bist ein KI-Agent. Dieser Repo ist dein Memory-System. Hier ist wie es funktioniert.

## 1. Einmalig: Brain starten

```bash
git clone https://github.com/pquandel2-alt/pq_brain.git
cd pq_brain
npm install
cp data/brain.example.json data/brain.json
node server.js
# Server läuft auf http://localhost:3000
```

Das wars. Brain läuft jetzt auf Port 3000.

---

## 2. Zu Beginn jeder Konversation: Brain lesen

```bash
curl -s http://localhost:3000/api/brain
```

**Du erhältst:**
```json
{
  "nodes": [
    {
      "id": "...",
      "label": "...",
      "type": "memory|project|idea|note|reference",
      "content": "# Markdown\n\nDas ist was du liest.",
      "tags": [...]
    },
    ...
  ],
  "links": [
    { "source": "...", "target": "...", "label": "..." },
    ...
  ]
}
```

**Du machst:**
1. Lese das gesamte `content` Feld von jedem Node als Kontext
2. Verwende die Links um zu verstehen, wie Konzepte zusammenhängen
3. Start-Knoten zeigt dir die 6 Standard-Kategorien

---

## 3. Die 6 Standard-Knoten

| Label | Typ | Inhalt |
|-------|-----|--------|
| `Start` | memory | Einstiegspunkt, erklärt wie Brain funktioniert |
| `User Profil` | memory | Wer ist der Nutzer? Umgebung? Erfahrung? |
| `Feedback` | memory | Was funktioniert? Was vermeiden? Bestätigte Ansätze? |
| `Projekte` | project | Aktive Projekte, Ziele, Versionen, Status |
| `Ideen` | idea | Unvalidierte Ideen, zukünftige Arbeit |
| `Notizen` | note | Technische Muster, Architektur-Entscheidungen |
| `Referenzen` | reference | Externe Pointers (URLs, APIs, Tooling) |

Jedes dieser Knoten ist voll mit Markdown. **Lese alle.** Das ist dein Kontext.

---

## 4. Während du arbeitest: verwende Brain als Kontext

Wenn Brain sagt:
- "User bevorzugt Deutsch" → antworte auf Deutsch
- "Token-Disziplin bei großen Dateien" → nutze Grep + Window-Read statt ganze Datei
- "Brain ist primäre Wissensquelle" → ignoriere alte .md-Dateien
- "Projekte haben bestimmte Versionen" → nutze diese Versionen

Brain ist die **Single Source of Truth**. Alles andere ist veraltet.

---

## 5. Wenn sich was ändert: schreib zurück

Drei Fälle:

### Fall 1: Neue Tatsache über den Nutzer/Projekt

Beispiel: du lernst, dass Node 20 installiert ist (aber Brain sagt Node 18)

```bash
curl -X PUT http://localhost:3000/api/nodes/user-profil \
  -H "Content-Type: application/json" \
  -d '{"content": "... aktualisiertes Markdown ..."}'
```

### Fall 2: Neues Feedback / bestätigter Ansatz

Beispiel: User sagt "ja genau, halte Knoten klein"

```bash
curl -X PUT http://localhost:3000/api/nodes/feedback \
  -H "Content-Type: application/json" \
  -d '{"content": "## Altes Feedback\n...\n\n## Knoten klein halten\n\n**Rule:** Max 5 Punkte pro Standard-Knoten, sub-Knoten für Details.\n\n**Why:** User bestätigt, übersichtlich bleibt schneller zu lesen.\n\n**Applies to:** Alle zukünftigen Memory-Updates."}'
```

### Fall 3: Neue Idee / Sub-Projekt

Neu-Knoten sind rare. Nur wenn es wirklich ein separates Konzept ist:

```bash
curl -X POST http://localhost:3000/api/nodes \
  -H "Content-Type: application/json" \
  -d '{
    "label": "Thing Name",
    "type": "idea|project|note",
    "content": "# Markdown",
    "tags": ["optional"]
  }'
```

Result: `{ "id": "neu-knoten-id", ... }`

Dann link es:

```bash
curl -X POST http://localhost:3000/api/links \
  -H "Content-Type: application/json" \
  -d '{"source": "parent-id", "target": "neu-knoten-id"}'
```

---

## 6. REST API Schnellreferenz

```
GET    /api/brain                    → ganze Brain { nodes, links }
PUT    /api/nodes/:id                → Update (Felder mergen)
POST   /api/nodes                    → Create Node
DELETE /api/nodes/:id                → Delete Node + Links
POST   /api/links                    → Link erstellen
DELETE /api/links                    → Link löschen
POST   /api/import                   → .md-Dateien importieren (YAML-Frontmatter)
```

---

## 7. Was NOT zu tun

❌ Neue .md-Dateien anlegen
❌ Memo-Systeme doppeln (z.B. separate Memory-Dateien)
❌ Alte Konversations-Context speichern
❌ Code-Patterns in Brain speichern (lese Repository stattdessen)
❌ Timestamps oder temp state speichern

---

## 8. Beispiel-Workflow: Standard-Konversation

```
1. Agent starts
   → curl -s http://localhost:3000/api/brain

2. Agent receives 7 nodes (Start, User, Feedback, Projekte, Ideen, Notizen, Refs)
   → Liest alle content Felder

3. User asks: "Neue Widget-Karte?"
   → Agent prüft Feedback: "README.md muss dabei sein"
   → Agent schaut Projekte: sieht die 10 Widgets + Versionen
   → Agent schaut Notizen: sieht Vanilla JS Pattern

4. Agent macht Arbeit

5. User sagt: "gut gemacht, mach das immer so"
   → Agent PUT /api/nodes/feedback
   → Feedback-Knoten wird mit neuem Punkt erweitert

6. Nächster Agent kommt
   → curl -s http://localhost:3000/api/brain
   → Sieht neues Feedback sofort
   → Agiert entsprechend
```

---

## 9. Betrieb

### ⭐ Auto-Start auf Boot (systemd Service)

Brain muss als systemd-Service laufen, damit es nach Server-Neustart automatisch wieder startet.

**Einrichtung (einmalig, braucht sudo):**

```bash
sudo ./setup-service.sh
```

Das Script:
1. Installiert `/etc/systemd/system/pq-brain.service`
2. Aktiviert Auto-Start mit `systemctl enable pq-brain`
3. Startet den Service sofort

**Status prüfen:**

```bash
systemctl status pq-brain
```

**Logs ansehen:**

```bash
journalctl -u pq-brain -f       # live
journalctl -u pq-brain -n 100   # letzte 100 Zeilen
```

**Service kontrollieren:**

```bash
systemctl restart pq-brain      # neu starten
systemctl stop pq-brain         # stoppen
systemctl disable pq-brain      # Auto-Start deaktivieren
```

### Backup

```bash
cp data/brain.json data/brain.backup.$(date +%s).json
```

### Netzwerk-Zugriff

Brain läuft auf `0.0.0.0:3000`, also erreichbar von überall auf dem Netzwerk:
```
http://<your-ip>:3000
```

---

## 10. Häufige Fehler

| Fehler | Fix |
|--------|-----|
| "Cannot POST /api/nodes" | Node mit `POST`, nicht `PUT` |
| "Source node not found" | Node-IDs sind UUIDs, kopiere exakt |
| "Link already exists" | Brain dedupliziert, ist ok |
| "No such file" | curl prüft ob `data/brain.json` existiert |
| "Port 3000 in use" | `PORT=3002 node server.js` |

---

## Fertig!

Jeder neue Agent, der diesen Repo klont, kennt sofort:
- Was der Nutzer erwartet
- Welche Projekte laufen
- Welche Technischen Patterns zu nutzen sind
- Welche Feedback-Regeln gelten

Kein Rätselraten. Brain ist die Quelle der Wahrheit.
