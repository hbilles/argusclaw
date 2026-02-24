# Google OAuth Setup (Gmail & Calendar)

ArgusClaw integrates directly with Gmail and Google Calendar to read emails, send emails, list events, and create/update events.

Because ArgusClaw is a personal, self-managed application, you need to create your own Google Cloud project and supply your own OAuth credentials.

## Step 1: Create a Google Cloud Project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Click the **Select a project** dropdown at the top left, and then click **New Project**.
3. Name your project (e.g., "ArgusClaw Integrations") and click **Create**.

## Step 2: Enable the APIs

1. In your new project, open the side navigation menu and go to **APIs & Services** > **Library**.
2. Search for **Gmail API**. Click it and click **Enable**.
3. Go back to the Library, search for **Google Calendar API**. Click it and click **Enable**.

## Step 3: Configure the OAuth Consent Screen

1. In the sidebar under **APIs & Services**, click **OAuth consent screen**.
2. Select **External** (unless you have a Google Workspace account and want to keep it Internal) and click **Create**.
3. Fill in the required fields:
   - App name (e.g., "ArgusClaw")
   - User support email
   - Developer contact information
4. Click **Save and Continue**.
5. *Scopes (Optional):* You don't necessarily need to configure scopes here since ArgusClaw will request them dynamically at authorization time. Click **Save and Continue**.
6. **Test Users:** Since your app is 'External' and in 'Testing' mode, you **must** add your own Google email address as a Test User. Click **Add Users**, type your email, and click **Save and Continue**.

## Step 4: Create OAuth 2.0 Credentials

1. In the sidebar, click **Credentials**.
2. Click **+ Create Credentials** at the top, and select **OAuth client ID**.
3. Under **Application type**, choose **Desktop app**. (Desktop apps inherently allow localhost loopback redirects).
   - *Note: If you choose "Web application" instead, you must add `http://localhost:9876/auth/google/callback` to the authorized redirect URIs.*
4. Name the client (e.g., "ArgusClaw Local Client") and click **Create**.
5. A dialog will appear with your **Client ID** and **Client Secret**. Leave this page open or copy these values.

## Step 5: Update `argusclaw.yaml`

1. Open `config/argusclaw.yaml` (copy it from `config/argusclaw.example.yaml` if you haven't already).
2. Find the `oauth.google` section.
3. Paste in your Client ID and Client Secret:

```yaml
oauth:
  google:
    clientId: your-client-id.apps.googleusercontent.com
    clientSecret: your-client-secret
    callbackPort: 9876
```

## Step 6: Authenticate

1. Start your ArgusClaw gateway: `npm run dev` or via Docker.
2. In your messaging interface (Telegram or Slack), run the connect command:
   - **Telegram:** `/connect google`
   - **Slack:** `/argus_connect google`
3. Click the authorization link provided by the bot. This will open Google's OAuth screen in your browser.
4. Because this is your own unverified test app, you will likely see a "Google hasn't verified this app" warning. Click **Advanced** and then **Go to ArgusClaw (unsafe)**.
5. Grant the checkboxed permissions for Gmail and Google Calendar.
6. The app will redirect to `http://localhost:9876/auth/google/callback` and display a success message confirming the connection.

*If you are running ArgusClaw on a remote server/VPS and cannot route `localhost:9876` in your browser:*
When you reach the broken localhost page after granting permissions, copy the entire URL from your browser's address bar and send it to your bot:

- **Telegram:** `/connect google callback <url-or-code>`
- **Slack:** `/argus_connect google callback <url-or-code>`

ArgusClaw will securely store the Refresh and Access tokens in its SQLite database (encrypted using your `OAUTH_KEY` environment variable).

You can verify the status at any time using `/auth_status google` (Telegram) or `/argus_auth_status google` (Slack), and remove your account with `/disconnect google` (Telegram) or `/argus_disconnect google` (Slack).
