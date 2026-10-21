# Handy-Tracker einrichten (Supabase + GitHub Pages)

Einmalig, ca. 10 Minuten. Die Mitarbeiter brauchen danach **kein eigenes Konto** – nur den Link und das Laden-Passwort.

## 1. Datenbank anlegen

1. Auf <https://supabase.com> ein kostenloses Konto erstellen und ein neues Projekt anlegen (Region: Frankfurt / `eu-central-1`).
2. Links **SQL Editor** öffnen, folgenden Block einfügen und auf **Run** klicken:

```sql
create table if not exists devices (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists settings (
  id text primary key,
  data jsonb not null
);

alter table devices enable row level security;
alter table settings enable row level security;

-- Nur angemeldete Nutzer (der Laden-Zugang) dürfen lesen und schreiben
create policy "laden devices" on devices for all to authenticated using (true) with check (true);
create policy "laden settings" on settings for all to authenticated using (true) with check (true);

-- Live-Aktualisierung zwischen den Filialen
alter publication supabase_realtime add table devices, settings;

-- Startwerte
insert into settings (id, data) values ('main', '{
  "locations": ["Freilassing", "Globus", "Bad Reichenhall", "Techniker", "An Kunde ausgegeben"],
  "employees": ["Ernest", "Marin", "Erik"]
}') on conflict (id) do nothing;
```

## 2. Laden-Zugang (gemeinsames Passwort) anlegen

1. Links **Authentication → Users → Add user → Create new user**.
2. E-Mail: `laden@example.com` (genau so – sie steht als `SHOP_EMAIL` in `index.html`).
3. Passwort: euer Laden-Passwort (mind. 8 Zeichen, nicht zu einfach).
4. Haken bei **Auto Confirm User** setzen → **Create user**.
5. Unter **Authentication → Sign In / Providers → Email** die Option **Allow new users to sign up** ausschalten, damit sich niemand sonst registrieren kann.

Passwort ändern (z. B. wenn jemand den Laden verlässt): beim Nutzer `laden@example.com` auf **…** → **Change password** – danach auf allen Geräten neu anmelden.

## 3. App verbinden

In **Project Settings → API** stehen die **Project URL** und der **anon public**-Schlüssel. Beide oben im `<script>` von `handy-tracker/index.html` bei `SUPABASE_URL` und `SUPABASE_ANON_KEY` eintragen.
Der `anon`-Schlüssel darf öffentlich sein; den **service_role**-Schlüssel niemals in die App oder weitergeben.

## 4. Website freischalten (GitHub Pages)

Im Repository auf GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, Branch `main`, Ordner `/ (root)` → **Save**.
Nach 1–2 Minuten ist die App erreichbar unter:

`https://astroxof.github.io/astrox-website/handy-tracker/`
