# Dedicated PUBLIC-SHARE-3 gateway. This image contains nginx plus one template;
# it has no application, database client, storage mount, or credential.
FROM nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752

RUN rm -f /etc/nginx/conf.d/default.conf \
    && mkdir -p /etc/nginx/templates \
    && chown -R 101:101 /etc/nginx/templates

COPY --chown=101:101 nginx.conf.template /etc/nginx/templates/nginx.conf.template

ENV NGINX_ENVSUBST_OUTPUT_DIR=/tmp

USER 101:101
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
    CMD wget -qO- http://127.0.0.1:8081/healthz >/dev/null || exit 1

STOPSIGNAL SIGQUIT
CMD ["nginx", "-g", "daemon off;", "-c", "/tmp/nginx.conf"]
