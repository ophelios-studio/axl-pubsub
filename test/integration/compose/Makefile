# macOS note: default `openssl` is LibreSSL and does not support ed25519.
# Use Homebrew's openssl@3:
#   make OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl keys
OPENSSL ?= openssl

.PHONY: keys build up down logs clean

keys:
	@mkdir -p keys
	@for name in alice bob charlie; do \
		if [ -f keys/$$name.pem ]; then \
			echo "keys/$$name.pem exists, skipping"; \
		else \
			$(OPENSSL) genpkey -algorithm ed25519 -out keys/$$name.pem && \
			chmod 600 keys/$$name.pem && \
			echo "wrote keys/$$name.pem"; \
		fi; \
	done

build:
	docker compose build

up: keys
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

clean: down
	rm -f keys/*.pem
