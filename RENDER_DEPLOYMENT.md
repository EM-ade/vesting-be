# Render Deployment Guide

## Changes Made to Fix Deployment Error

### Problem
Render was trying to run `node index.js` but couldn't find the file because:
- TypeScript files need to be compiled first
- The compiled output is in the `dist` folder, not the `src` folder

### Solution

#### 1. Updated `package.json`
- Changed `"main"` from `"index.js"` to `"dist/api/server.js"`
- Added postbuild verification to ensure compilation succeeds
- Enhanced build script with success message

#### 2. Updated `render.yaml`
- Changed `buildCommand` to use `npm ci` (faster, more reliable for CI/CD)
- Changed `startCommand` to directly run `node dist/api/server.js` instead of `npm start`

## Deployment Steps

1. **Commit and push your changes:**
   ```bash
   git add backend/package.json backend/render.yaml
   git commit -m "Fix Render deployment configuration"
   git push
   ```

2. **Render will automatically:**
   - Run `npm ci` to install dependencies
   - Run `npm run build` which compiles TypeScript to `dist` folder
   - Run the postbuild check to verify `dist/api/server.js` exists
   - Start the server with `node dist/api/server.js`

3. **Verify deployment:**
   - Check Render logs for "Build completed successfully"
   - Check for "🚀 Vesting API server running on port XXXX"
   - Test the health endpoint: `https://your-app.onrender.com/health`

## Local Testing

Test the same commands that Render will run:

```bash
cd backend
npm ci
npm run build
node dist/api/server.js
```

## Environment Variables

Make sure these are set in your Render dashboard:
- `NODE_ENV=production`
- `PORT=3001`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `HELIUS_API_KEY`
- `CUSTOM_TOKEN_MINT`
- `TREASURY_PRIVATE_KEY`
- `CLAIM_FEE_USD`
- `ALLOWED_ORIGINS`
- `NFT_COLLECTION_ADDRESS`
- `FEE_WALLET`
- `CRON_SECRET`
- `ADMIN_WALLETS`

## Troubleshooting

If you still see errors:

1. **Check build logs** - Look for TypeScript compilation errors
2. **Verify dist folder** - The build should create `dist/api/server.js`
3. **Check start command** - Should see "🚀 Vesting API server running"
4. **Node version** - Render uses Node.js v22.16.0, ensure compatibility

## Notes

- Using `npm ci` instead of `npm install` ensures consistent builds
- The postbuild script will fail the deployment if compilation doesn't work
- Direct node command in startCommand avoids npm overhead
