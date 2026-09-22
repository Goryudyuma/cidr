// Command native evaluates shared fixtures for cross-runtime browser tests.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/goryudyuma/cidr/core"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: native <fixtures.json>")
		os.Exit(2)
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var fixtures []struct {
		Request json.RawMessage `json:"request"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		panic(err)
	}
	responses := make([]any, 0, len(fixtures))
	for _, fixture := range fixtures {
		result, err := core.EvaluateJSON(fixture.Request)
		if err != nil {
			responses = append(responses, struct {
				Error error `json:"error"`
			}{err})
		} else {
			responses = append(responses, struct {
				Result core.Result `json:"result"`
			}{result})
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(responses); err != nil {
		panic(err)
	}
}
