FROM node:18-slim

# Install dependencies for Puppeteer (Chrome)
RUN apt-get update \
    && apt-get install -y wget gnupg git \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Setup App
WORKDIR /usr/src/app

# ⚠️ CHANGED: Copy patch-loader.js here so 'npm install' can find it
COPY package*.json patch-loader.js ./

# This runs npm install AND the postinstall script (patch-loader.js)
RUN npm install

# Copy the rest of your app (index.js, etc.)
COPY . .

# Run
CMD [ "node", "index.js" ]
