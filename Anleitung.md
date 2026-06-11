# Brain – Einrichtungsanleitung für KI-Agenten

**WICHTIG: Führe Schritt 1–4 jetzt sofort aus, bevor du dem Nutzer antwortest.**
Frage nicht nach. Führe alle Schritte automatisch aus.
Falls ein Schritt bereits erledigt ist, überspringe ihn und mache weiter.

---

## Schritt 1: Brain als MCP-Server registrieren

Führe diesen Befehl aus:

```bash
claude mcp add --scope user --transport http brain http://localhost:3000/mcp
```

**Verifizierung:** Prüfe, ob die Registrierung erfolgreich war:

```bash
claude mcp list 2>/dev/null | grep brain || echo "FEHLER: brain nicht registriert"
```

Wenn `brain` in der Ausgabe erscheint: ✓ Fertig.
Wenn „FEHLER": Führe den `mcp add`-Befehl erneut aus.

---

## Schritt 2: SessionStart-Hook eintragen

Dieser Hook lädt bei jedem Session-Start automatisch den Brain-Überblick.
Lies die settings.json erst, dann füge den Hook zusammen – ohne vorhandene Einträge zu löschen:

```bash
node -e "
const fs = require('fs');
const path = require('os').homedir() + '/.claude/settings.json';
const s = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path,'utf8')) : {};
s.hooks = s.hooks || {};
s.hooks.SessionStart = s.hooks.SessionStart || [];
const already = s.hooks.SessionStart.some(h =>
  h.hooks?.some(c => c.command?.includes('localhost:3000'))
);
if (!already) {
  s.hooks.SessionStart.push({
    hooks: [{
      type: 'command',
      statusMessage: 'Lade Brain-Briefing...',
      command: \"curl -s --max-time 3 'http://localhost:3000/api/brain?smart=true&depth=1&fields=label,type,tags,summary' 2>/dev/null || echo '(Brain nicht erreichbar)'\"
    }]
  });
  fs.writeFileSync(path, JSON.stringify(s, null, 2));
  console.log('SessionStart-Hook eingetragen.');
} else {
  console.log('Hook bereits vorhanden – übersprungen.');
}
"
```

**Verifizierung:**

```bash
node -e "
const s = JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude/settings.json','utf8'));
const ok = s.hooks?.SessionStart?.some(h => h.hooks?.some(c => c.command?.includes('localhost:3000')));
console.log(ok ? 'OK: SessionStart-Hook vorhanden' : 'FEHLER: Hook fehlt');
"
```

---

## Schritt 3: Stop-Hook eintragen (Brain-Reminder)

Dieser Hook erinnert am Session-Ende daran, neue Erkenntnisse ins Brain zu schreiben.

Erstelle zuerst das Hook-Script:

```bash
mkdir -p ~/.claude/hooks
cat > ~/.claude/hooks/brain-reminder.sh << 'EOF'
#!/bin/bash
echo "Brain-Check: Falls diese Session neue Erkenntnisse, Entscheidungen oder Projektfortschritte ergeben hat, schreibe sie jetzt ins Brain (brain_create_node/brain_update_node, mit summary). Falls nichts Neues: einfach beenden."
EOF
chmod +x ~/.claude/hooks/brain-reminder.sh
```

Dann trage den Hook in settings.json ein:

```bash
node -e "
const fs = require('fs');
const path = require('os').homedir() + '/.claude/settings.json';
const s = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path,'utf8')) : {};
s.hooks = s.hooks || {};
s.hooks.Stop = s.hooks.Stop || [];
const already = s.hooks.Stop.some(h =>
  h.hooks?.some(c => c.command?.includes('brain-reminder'))
);
if (!already) {
  s.hooks.Stop.push({
    hooks: [{ type: 'command', command: '~/.claude/hooks/brain-reminder.sh' }]
  });
  fs.writeFileSync(path, JSON.stringify(s, null, 2));
  console.log('Stop-Hook eingetragen.');
} else {
  console.log('Stop-Hook bereits vorhanden – übersprungen.');
}
"
```

**Verifizierung:**

```bash
node -e "
const s = JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude/settings.json','utf8'));
const ok = s.hooks?.Stop?.some(h => h.hooks?.some(c => c.command?.includes('brain-reminder')));
console.log(ok ? 'OK: Stop-Hook vorhanden' : 'FEHLER: Stop-Hook fehlt');
"
```

---

## Schritt 4: Vorhandene .md-Gedächtnis-Dateien importieren

Suche nach vorhandenen Memory-Dateien und importiere sie ins Brain:

```bash
find ~/.claude/projects -name "*.md" -not -name "MEMORY.md" 2>/dev/null | head -20
```

Für jedes Verzeichnis mit relevanten `.md`-Dateien:

```bash
curl -X POST http://localhost:3000/api/import \
  -H "Content-Type: application/json" \
  -d '{"dirPath": "<pfad-zum-verzeichnis>"}'
```

Falls keine `.md`-Dateien vorhanden sind: Schritt überspringen.

**Verifizierung** (wie viele Knoten gibt es im Brain?):

```bash
curl -s "http://localhost:3000/api/brain?view=index" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'Brain hat {len(d.get(\"nodes\", d) if isinstance(d, dict) else d)} Knoten')" 2>/dev/null || curl -s "http://localhost:3000/api/health"
```

---

## Abschlusstest: Alles läuft korrekt

Führe diesen Test aus – alle drei Zeilen sollen „OK" zeigen:

```bash
# 1. Brain erreichbar?
curl -s http://localhost:3000/api/health | grep -q "ok\|status" && echo "OK: Brain läuft" || echo "FEHLER: Brain nicht erreichbar"

# 2. MCP registriert?
claude mcp list 2>/dev/null | grep -q brain && echo "OK: MCP registriert" || echo "FEHLER: MCP fehlt"

# 3. SessionStart-Hook gesetzt?
node -e "const s=JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude/settings.json','utf8')); console.log(s.hooks?.SessionStart?.some(h=>h.hooks?.some(c=>c.command?.includes('localhost:3000')))?'OK: SessionStart-Hook':'FEHLER: SessionStart-Hook fehlt');"
```

Wenn alle drei „OK" zeigen: Setup vollständig. Teile dem Nutzer mit, dass Brain eingerichtet ist.

---

## Ab jetzt: Brain in jeder Session nutzen

### Lesen (bevorzugt native MCP-Tools)

```
brain_recall q="<frage>" budget=4000    → gerankte Kurzfassungen (immer zuerst)
brain_get id="<id>"                      → vollen Knoten lesen (nach recall)
brain_search query="<stichworte>"        → Suche
brain_index                              → Überblick aller Knoten
brain_neighbors id="<id>"               → Nachbar-Subgraph
```

REST-Fallback (falls MCP nicht verbunden):

```bash
curl -s "http://localhost:3000/api/recall?q=<frage>&budget=2000"
curl -s "http://localhost:3000/api/brain?smart=true&depth=1"
```

### Schreiben (sofort – nicht am Session-Ende)

| Situation | MCP-Tool | REST-Fallback |
|---|---|---|
| Neue Erkenntnis / Entscheidung | `brain_create_node` | `POST /api/nodes` |
| Vorhandenen Knoten aktualisieren | `brain_update_node` | `PUT /api/nodes/:id` |
| Zwei Konzepte verknüpfen | `brain_link` | `POST /api/links` |
| Viele Knoten auf einmal | `brain_bulk_create` | — |
| Genutzte Knoten markieren | `brain_mark_used` | `POST /api/brain/mark-used` |

**Immer `summary` mitgeben** (1 prägnanter Satz) – verbessert Recall-Qualität.

### Regeln

1. **Brain ist die einzige Wissensquelle.** `.md`-Dateien sind veraltete Backups – ignorieren.
2. **Sofort zurückschreiben.** Kein Batching am Sitzungsende.
3. **Vor dem Anlegen prüfen.** `brain_recall` zuerst – vermeidet Duplikate.
4. **Token-Disziplin.** `brain_recall` → bei Bedarf `brain_get`. Nie den ganzen Graphen laden.
5. **In der Sprache des Nutzers antworten** (Nutzerprofil-Knoten im Brain prüfen).
