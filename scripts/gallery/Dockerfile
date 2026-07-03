# Static image for the assembled cross-platform TV gallery (gallery.html +
# shots/), path-routed onto the app preview host by the tv-gallery CI workflow
# (https://<preview-host>/tv-gallery/, next to the live web gallery at
# /gallery.html). Served under the /tv-gallery prefix so the Traefik
# PathPrefix route maps straight onto the filesystem. Built AFTER
# capture/assembly — the shots come from platform toolchains (Simulator,
# Robolectric) that can't run at app-image build time, which is why this is
# its own tiny image instead of riding the app image.
FROM nginx:alpine
# Clean-URL resolution (/gallery -> gallery.html), matching the app server.
COPY nginx.conf /etc/nginx/conf.d/default.conf
# The static cross-platform comparison, under its /tv-gallery prefix.
COPY gallery.html /usr/share/nginx/html/tv-gallery/index.html
COPY shots /usr/share/nginx/html/tv-gallery/shots
# The LIVE web gallery entry pages (public/gallery*), staged into webshell/ by
# the workflow. Served at the host root (/gallery.html etc.) via the same
# PathPrefix route; their iframes point at absolute paths (/?test=1&...) that
# route to the app preview pod on the same host, so they keep driving the real
# display app. These pages are excluded from the game image (.dockerignore);
# this image is their home.
COPY webshell /usr/share/nginx/html/
