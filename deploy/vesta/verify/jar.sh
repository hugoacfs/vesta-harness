#!/bin/bash
# Ensure a valid staging cookie jar at /tmp/jar-staging.txt without ever printing the launch token.
S=https://vesta.tail22b555.ts.net/harness-staging
J=/tmp/jar-staging.txt
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$J" "$S/api/vesta/routines" 2>/dev/null)
if [ "$code" = "200" ]; then echo "jar ok ($code)"; exit 0; fi
url=$(ssh vesta '~/.local/bin/vesta-url staging' 2>/dev/null | grep -oE 'https://[^ ]+token=[^ ]+' | head -1)
[ -n "$url" ] || { echo "could not mint a staging URL"; exit 1; }
rm -f "$J"
ex=$(curl -s -o /dev/null -w '%{http_code}' -c "$J" "$url")
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$J" "$S/api/vesta/routines")
echo "minted: exchange $ex, list $code"
[ "$code" = "200" ]
