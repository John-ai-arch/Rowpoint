# RowPoint — single-container deployment.
#   docker build -t rowpoint .
#   docker run -p 3000:3000 -v rowpoint-data:/data -e RESEND_API_KEY=re_xxx rowpoint
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server ./server
COPY public ./public
ENV NODE_ENV=production \
    ROWPOINT_DATA_DIR=/data \
    PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
