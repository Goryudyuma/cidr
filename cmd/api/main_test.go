package main

import (
	"net/http"
	"testing"
)

func TestServerHasResourceTimeouts(t *testing.T) {
	server := newServer("127.0.0.1:8080", http.NotFoundHandler())
	if server.ReadHeaderTimeout <= 0 || server.ReadTimeout <= 0 || server.WriteTimeout <= 0 || server.IdleTimeout <= 0 || server.MaxHeaderBytes <= 0 {
		t.Fatal("HTTP server must bound header reading, body reading, response writing, idle connections and header bytes")
	}
}
