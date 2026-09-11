package main

import (
	"bufio"
	"strings"
	"testing"
)

const sampleTCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0
   1: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 23456 1 0000000000000000 100 0 0 10 5
   2: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 34567 1 0000000000000000 20 0 0 10 -1`

func TestParseProcNet(t *testing.T) {
	ports := make(map[uint16]bool)
	parseProcNet(bufio.NewScanner(strings.NewReader(sampleTCP)), ports)

	if !ports[8080] || !ports[80] {
		t.Fatalf("LISTEN ports missing: %v", ports)
	}
	if ports[50000] {
		t.Fatalf("ESTABLISHED (st=01) must be skipped: %v", ports)
	}
}

func TestParseProcNetGarbage(t *testing.T) {
	ports := make(map[uint16]bool)
	parseProcNet(bufio.NewScanner(strings.NewReader("garbage\n::::\n\n")), ports)
	if len(ports) != 0 {
		t.Fatalf("garbage must yield nothing: %v", ports)
	}
}

func TestSortedKeys(t *testing.T) {
	got := sortedKeys(map[uint16]bool{9000: true, 80: true, 443: true})
	if got[0] != 80 || got[1] != 443 || got[2] != 9000 {
		t.Fatalf("not sorted: %v", got)
	}
}
