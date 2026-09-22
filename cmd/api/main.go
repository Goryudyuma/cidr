// Command api serves the native Go evaluator over HTTP.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/goryudyuma/cidr/internal/httpapi"
)

func main() {
	options := httpapi.DefaultOptions()
	addr := flag.String("addr", "127.0.0.1:8080", "HTTP listen address")
	corsOrigins := flag.String("cors-origins", "", "comma-separated exact allowed CORS origins (disabled by default)")
	flag.IntVar(&options.Limits.MaxBodyBytes, "max-body-bytes", options.Limits.MaxBodyBytes, "maximum request body bytes (positive)")
	flag.IntVar(&options.Limits.MaxInitial, "max-initial", options.Limits.MaxInitial, "maximum initial entries (positive)")
	flag.IntVar(&options.Limits.MaxOperations, "max-operations", options.Limits.MaxOperations, "maximum operations (positive)")
	flag.IntVar(&options.Limits.MaxOutputCIDRs, "max-cidrs", options.Limits.MaxOutputCIDRs, "maximum output CIDRs (positive)")
	flag.IntVar(&options.Limits.MaxOutputRanges, "max-ranges", options.Limits.MaxOutputRanges, "maximum output ranges (positive)")
	flag.DurationVar(&options.EvaluationTimeout, "evaluation-timeout", options.EvaluationTimeout, "maximum evaluation duration, e.g. 15s (positive)")
	flag.IntVar(&options.MaxConcurrent, "max-concurrent", options.MaxConcurrent, "maximum concurrent requests, including body read and response write (positive)")
	flag.Parse()
	if flag.NArg() != 0 {
		log.Fatal("unexpected positional arguments")
	}

	if *corsOrigins != "" {
		for _, origin := range strings.Split(*corsOrigins, ",") {
			options.AllowedOrigins = append(options.AllowedOrigins, strings.TrimSpace(origin))
		}
	}
	handler, err := httpapi.NewHandler(options)
	if err != nil {
		log.Fatal(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server := newServer(*addr, handler)
	// Preserve the default 30s write timeout, and make a configured longer
	// evaluation budget usable. Duration arithmetic cannot overflow silently.
	if options.EvaluationTimeout > server.WriteTimeout-15*time.Second {
		server.WriteTimeout = options.EvaluationTimeout
		if options.EvaluationTimeout <= time.Duration(1<<63-1)-15*time.Second {
			server.WriteTimeout += 15 * time.Second
		}
	}
	if err := run(ctx, server); err != nil {
		log.Fatal(err)
	}
}

func newServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
}

func run(ctx context.Context, server *http.Server) error {
	serveErr := make(chan error, 1)
	go func() {
		log.Printf("IP-set API listening on %s", server.Addr)
		serveErr <- server.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			_ = server.Close()
			return fmt.Errorf("graceful shutdown: %w", err)
		}
		if err := <-serveErr; err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}
