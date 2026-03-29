# KUP Production Deployment Guide

## Target: keepuspostd.com → Google Cloud VM (34.134.246.139)

### Pre-Deployment Checklist

Before deploying, Santana needs to:

1. **PayPal Live Credentials** — Go to developer.paypal.com → Live tab:
   - Copy Client ID and Secret → paste in `.env.production`
   - Create a webhook → copy Webhook ID → paste as `PAYPAL_WEBHOOK_ID`
   - Create live subscription plans (run setup script with live credentials)

2. **MongoDB** — Decide: same Atlas cluster with new DB name (`keepuspostd_production`) or new cluster?
   - Same cluster is fine for launch. Data is isolated by database name.

3. **Firebase Console** — Authentication → Templates:
   - Set custom action URL to: `https://keepuspostd.com/pages/auth-action.html`
   - This makes password reset and email verification links go to our branded pages

4. **SendGrid Domain Authentication** (optional but recommended):
   - Go to app.sendgrid.com → Settings → Sender Authentication → Domain Authentication
   - Add `keepuspostd.com` and update DNS records in GoDaddy

---

### Deployment Steps

#### Step 1: SSH into the VM
```bash
gcloud compute ssh [VM_NAME] --zone=[ZONE]
# OR
ssh user@34.134.246.139
```

#### Step 2: Install Node.js (if not installed)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version  # Should be 20.x
```

#### Step 3: Install PM2 (process manager)
```bash
sudo npm install -g pm2
```

#### Step 4: Clone or upload the code
```bash
cd /var/www
git clone https://github.com/KeepUsPostd/kup-test.git keepuspostd
cd keepuspostd
```

#### Step 5: Install dependencies
```bash
npm install --production
```

#### Step 6: Copy production env file
```bash
# Upload .env.production to the server (scp, nano, etc.)
# Make sure all REPLACE_WITH values are filled in
cp .env.production .env.production  # it reads from this file
```

#### Step 7: Start with PM2
```bash
NODE_ENV=production pm2 start src/server.js --name kup-production
pm2 save
pm2 startup  # Auto-start on reboot
```

#### Step 8: Configure Nginx
```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/keepuspostd
sudo ln -sf /etc/nginx/sites-available/keepuspostd /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default  # Remove default site
sudo nginx -t  # Test config
sudo systemctl reload nginx
```

#### Step 9: SSL Certificate (Let's Encrypt)
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d keepuspostd.com -d www.keepuspostd.com
# Follow prompts, select redirect HTTP to HTTPS
```

#### Step 10: Verify
```bash
curl https://keepuspostd.com/api/health
# Should return: {"status":"ok","environment":"production",...}
```

---

### Post-Deployment

- **Monitor logs**: `pm2 logs kup-production`
- **Restart**: `pm2 restart kup-production`
- **Update code**: `git pull && npm install && pm2 restart kup-production`
- **SSL auto-renewal**: certbot sets up a cron automatically

### QR Code Preservation
The 10 protected brands' market codes are stored in MongoDB. As long as the database is preserved (or migrated correctly), all QR codes will continue to work. The codes resolve via the `/api/kiosk` routes which are unchanged.

### Rollback
If something goes wrong:
```bash
pm2 stop kup-production
# Re-enable the old nginx config if needed
sudo systemctl reload nginx
```
