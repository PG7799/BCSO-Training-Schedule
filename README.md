# BCSO Training Operations Center

A static website for coordinating training across BCSO divisions. It uses Supabase Auth + Postgres for accounts, permissions, division records, training events, and server-side overlap prevention. The calendar is powered by FullCalendar.

## Included
- Email/password sign-in and account creation
- Shared calendar across divisions
- Create, edit, cancel, and review training sessions
- Automatic database-level overlap prevention across all divisions
- A Training Command-only queue for reviewing, approving, and denying overlap requests
- Division schedulers, commanders, co-commanders, and system administrators
- Admin tools to add divisions and grant division access by email
- Dashboard and completed/cancelled history
- Responsive layout for desktop and mobile

## 1. Create and configure Supabase
1. Create a project at https://supabase.com.
2. Open **SQL Editor → New query**.
3. Paste all of `supabase/schema.sql` and run it.
4. Open **Project Settings → API** and copy the Project URL and anon/publishable key.
5. Copy `config.js.example` to `config.js` and fill in those two values.
6. In Supabase **Authentication → URL Configuration**, add your deployed site URL to Site URL and Redirect URLs. For local testing, add `http://localhost:8000/**`.
7. For a private role-play department, consider requiring email confirmation and only distributing the site to authorized personnel.

Do not put a Supabase `service_role` key in `config.js` or any browser code. The anon/publishable key is safe for browser use only because Row Level Security policies protect the database.

## 2. Create your first administrator
1. Register your own account through the website.
2. Confirm the email if Supabase requires it.
3. Sign in once so the profile trigger creates your profile.
4. In Supabase SQL Editor, run (replace the email):
   ```sql
   update public.profiles
   set role = 'admin'
   where email = 'your-email@example.com';
   ```
5. Sign out and back in. You should now see **Division Management**.

## 3. Add personnel and division access
1. Ask each division scheduler/commander to create an account.
2. As an administrator, open **Division Management**.
3. Use **Division access** to enter the exact email they registered with, choose their division and access level, and grant access.
4. A scheduler can create training for that division. Division commanders and co-commanders can also edit/cancel that division's training. System admins can manage all divisions.

All signed-in personnel can view the shared calendar. Only authorized division members can create training.

## 4. Run locally
The website is plain HTML/CSS/JS; no build step is required. From this folder run:
```bash
python -m http.server 8000
```
Then open `http://localhost:8000`. Make sure `config.js` exists first.

## 5. Deploy to GitHub Pages
1. Create a GitHub repository and upload the contents of this folder (including `config.js`).
2. In repository **Settings → Pages**, select **Deploy from a branch**, choose `main` and `/ (root)`.
3. Save and wait for the Pages URL to publish.
4. Add that URL to Supabase Authentication's allowed redirect URLs.
5. If you use a public repository, remember that `config.js` contains the public anon/publishable key, not a secret. Security depends on correct RLS policies. Never commit a service-role key.

## Scheduling conflict behavior

The database rejects a training that overlaps another scheduled training. Back-to-back sessions are allowed, and completed/cancelled sessions do not block new sessions. When a conflict is detected, the form automatically submits the full proposed session to the Training Command review queue rather than adding it to the calendar.

Only accounts on the private Training Command allowlist can see the **Overlap Requests** tab. Command members can review the requester, division, instructor, dates and times, location, participant limit, full description, and the scheduled sessions currently in conflict. They can approve and schedule the request or deny it with an optional review note. Approval rechecks the schedule inside the database and records the reviewer and whether an overlap exception was actually required. Requesters receive a request reference and a one-time cancellation code; the code is stored as a hash and transferred to the resulting training only if approved.

### Install the overlap approval queue

After the existing scheduling/cancellation setup and the Training Command allowlist setup, run `supabase/training-overlap-approval-queue.sql` in Supabase SQL Editor. The expected order is:

1. `supabase/schema.sql`
2. `supabase/public-cancellation-migration.sql`
3. `supabase/training-command-overrides.sql`
4. `supabase/training-overlap-approval-queue.sql`

Add each authorized command account to `training_command_members` using the SQL example in `training-command-overrides.sql`. The new tab appears only after an account signs in and passes the `is_training_command()` check. Do not grant ordinary schedulers access to the allowlist table or the review RPCs.

## Important operational notes
- All times are stored as `timestamptz` and displayed in each viewer's local browser time zone.
- This starter version does not send Discord announcements, reminders, or email notifications. Those can be added later using a Supabase Edge Function and a Discord webhook stored as a server-side secret.
- This is a starter implementation. Test it with a few test accounts and divisions before relying on it for official department scheduling.
- If you already have a Supabase project with existing tables/policies, back it up and review the SQL before running. The script is designed for a new project.


## Public read-only schedule

A separate deputy-facing viewer is available at `/public/`. It reads the same Supabase `trainings` and `divisions` tables, refreshes when records change, and has no write controls or authentication flow.

Before the public page can display data, run `supabase/public-schedule-readonly.sql` in the Supabase SQL Editor. This grants the anonymous browser role **SELECT only** on active divisions and scheduled trainings; it does not grant write access or expose profiles, division memberships, overlap requests, or command records. The existing authenticated scheduler policies remain responsible for all writes.

The viewer uses the existing public anon/publishable key from `config.js`. Never use a service-role key in browser code. Enable GitHub Pages for the repository (Settings → Pages → Deploy from branch → main → /(root)); the public viewer will then be at `https://pg7799.github.io/BCSO-Training-Schedule/public/` if that is the configured Pages URL.


## Add the Dispatch division to an existing database

Run `supabase/add-dispatch-division.sql` in the Supabase SQL Editor. The statement safely creates the Dispatch division or reactivates it if it already exists. Once it is active, the existing website automatically includes Dispatch in the schedule form, history filter, and calendar division filters because those options are loaded from the `divisions` table.

For a brand-new database, Dispatch is also included in the starter division list in `supabase/schema.sql`.


## Add the K9 division to an existing database

Run `supabase/add-k9-division.sql` in the Supabase SQL Editor. It safely creates the K9 division or reactivates it if it already exists. The primary and public schedule pages load active divisions directly from Supabase, so K9 will automatically appear in the training dropdown and division filters after the database change.

For a brand-new database, K9 is also included in the starter division list in `supabase/schema.sql`.
