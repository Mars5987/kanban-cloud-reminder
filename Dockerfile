FROM node:22-alpine
WORKDIR /app

# 复制依赖文件
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# 复制应用代码
COPY server.js ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server.js"]
