FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ARG MEDDEID_SUBANNOTATION_PROFILE_PACKAGE=""
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
COPY profile-packages/ /tmp/meddeid-profile-packages/
RUN npm ci --omit=dev \
    && if [ -n "$MEDDEID_SUBANNOTATION_PROFILE_PACKAGE" ]; then \
         if [ -f "/tmp/meddeid-profile-packages/$MEDDEID_SUBANNOTATION_PROFILE_PACKAGE" ]; then \
           npm install --omit=dev --no-save "/tmp/meddeid-profile-packages/$MEDDEID_SUBANNOTATION_PROFILE_PACKAGE"; \
         else \
           npm install --omit=dev --no-save "$MEDDEID_SUBANNOTATION_PROFILE_PACKAGE"; \
         fi; \
       fi \
    && rm -rf /tmp/meddeid-profile-packages \
    && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY scripts ./scripts
COPY shared ./shared
COPY contracts ./contracts
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
EXPOSE 8787
CMD ["npm", "start"]
