ARG NGINX_BASE_IMAGE
FROM ${NGINX_BASE_IMAGE}

COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 443

CMD ["nginx", "-g", "daemon off;"]
