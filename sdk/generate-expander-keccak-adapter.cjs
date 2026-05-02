#!/usr/bin/env node

const { mkdirSync, readFileSync, writeFileSync } = require("fs");
const { dirname, join, resolve } = require("path");

const repoRoot = resolve(__dirname, "..");

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find(value => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function adapterSource({ permutationCount, permutationOffset, batchFile }) {
  return `package main

import (
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"strconv"
	"strings"

	eccbuilder "github.com/PolyhedraZK/ExpanderCompilerCollection/builder"
	"github.com/PolyhedraZK/ExpanderCompilerCollection/ecgo"
	"github.com/PolyhedraZK/ExpanderCompilerCollection/ecgo/field/gf2"
	"github.com/PolyhedraZK/ExpanderCompilerCollection/ecgo/test"
	"github.com/consensys/gnark/frontend"
)

const NPermutations = ${permutationCount}
const PermutationOffset = ${permutationOffset}

var batchPath = ${JSON.stringify(batchFile)}

var rcs [][]uint

func init() {
	var rc [24]*big.Int
	rc[0], _ = new(big.Int).SetString("0000000000000001", 16)
	rc[1], _ = new(big.Int).SetString("0000000000008082", 16)
	rc[2], _ = new(big.Int).SetString("800000000000808A", 16)
	rc[3], _ = new(big.Int).SetString("8000000080008000", 16)
	rc[4], _ = new(big.Int).SetString("000000000000808B", 16)
	rc[5], _ = new(big.Int).SetString("0000000080000001", 16)
	rc[6], _ = new(big.Int).SetString("8000000080008081", 16)
	rc[7], _ = new(big.Int).SetString("8000000000008009", 16)
	rc[8], _ = new(big.Int).SetString("000000000000008A", 16)
	rc[9], _ = new(big.Int).SetString("0000000000000088", 16)
	rc[10], _ = new(big.Int).SetString("0000000080008009", 16)
	rc[11], _ = new(big.Int).SetString("000000008000000A", 16)
	rc[12], _ = new(big.Int).SetString("000000008000808B", 16)
	rc[13], _ = new(big.Int).SetString("800000000000008B", 16)
	rc[14], _ = new(big.Int).SetString("8000000000008089", 16)
	rc[15], _ = new(big.Int).SetString("8000000000008003", 16)
	rc[16], _ = new(big.Int).SetString("8000000000008002", 16)
	rc[17], _ = new(big.Int).SetString("8000000000000080", 16)
	rc[18], _ = new(big.Int).SetString("000000000000800A", 16)
	rc[19], _ = new(big.Int).SetString("800000008000000A", 16)
	rc[20], _ = new(big.Int).SetString("8000000080008081", 16)
	rc[21], _ = new(big.Int).SetString("8000000000008080", 16)
	rc[22], _ = new(big.Int).SetString("0000000080000001", 16)
	rc[23], _ = new(big.Int).SetString("8000000080008008", 16)

	rcs = make([][]uint, 24)
	for i := 0; i < 24; i++ {
		rcs[i] = make([]uint, 64)
		for j := 0; j < 64; j++ {
			rcs[i][j] = rc[i].Bit(j)
		}
	}
}

type batchFileJSON struct {
	Schema           string              \`json:"schema"\`
	Commitment       string              \`json:"commitment"\`
	WitnessCommitment string              \`json:"witness_commitment"\`
	PermutationCount int                 \`json:"permutation_count"\`
	Permutations     []permutationRecord \`json:"permutations"\`
}

type permutationRecord struct {
	GlobalIndex int      \`json:"global_index"\`
	TaskID      string   \`json:"task_id"\`
	InputState  []string \`json:"input_state"\`
	OutputState []string \`json:"output_state"\`
}

type keccakTransitionCircuit struct {
	In  [NPermutations][1600]frontend.Variable
	Out [NPermutations][1600]frontend.Variable
}

func assertIsBoolean(api frontend.API, x frontend.Variable) {
	api.AssertIsEqual(api.Mul(x, x), x)
}

func xor(api frontend.API, a []frontend.Variable, b []frontend.Variable) []frontend.Variable {
	nbits := len(a)
	bitsRes := make([]frontend.Variable, nbits)
	for i := 0; i < nbits; i++ {
		bitsRes[i] = api.Add(a[i], b[i])
	}
	return bitsRes
}

func and(api frontend.API, a []frontend.Variable, b []frontend.Variable) []frontend.Variable {
	nbits := len(a)
	bitsRes := make([]frontend.Variable, nbits)
	for i := 0; i < nbits; i++ {
		bitsRes[i] = api.Mul(a[i], b[i])
	}
	return bitsRes
}

func not(api frontend.API, a []frontend.Variable) []frontend.Variable {
	bitsRes := make([]frontend.Variable, len(a))
	for i := 0; i < len(a); i++ {
		bitsRes[i] = api.Sub(1, a[i])
	}
	return bitsRes
}

func rotateLeft(bits []frontend.Variable, k int) []frontend.Variable {
	n := uint(len(bits))
	s := uint(k) & (n - 1)
	newBits := bits[n-s:]
	return append(newBits, bits[:n-s]...)
}

func keccakF(api frontend.API, a [][]frontend.Variable) [][]frontend.Variable {
	var b [25][]frontend.Variable
	for i := 0; i < len(b); i++ {
		b[i] = make([]frontend.Variable, 64)
		for j := 0; j < 64; j++ {
			b[i][j] = 0
		}
	}
	var c [5][]frontend.Variable
	for i := 0; i < len(c); i++ {
		c[i] = make([]frontend.Variable, 64)
		for j := 0; j < 64; j++ {
			c[i][j] = 0
		}
	}
	var d [5][]frontend.Variable
	for i := 0; i < len(d); i++ {
		d[i] = make([]frontend.Variable, 64)
		for j := 0; j < 64; j++ {
			d[i][j] = 0
		}
	}
	var da [5][]frontend.Variable
	for i := 0; i < len(d); i++ {
		da[i] = make([]frontend.Variable, 64)
		for j := 0; j < 64; j++ {
			da[i][j] = 0
		}
	}

	for i := 0; i < 24; i++ {
		c[0] = xor(api, xor(api, a[1], a[2]), xor(api, a[3], a[4]))
		c[1] = xor(api, xor(api, a[6], a[7]), xor(api, a[8], a[9]))
		c[2] = xor(api, xor(api, a[11], a[12]), xor(api, a[13], a[14]))
		c[3] = xor(api, xor(api, a[16], a[17]), xor(api, a[18], a[19]))
		c[4] = xor(api, xor(api, a[21], a[22]), xor(api, a[23], a[24]))

		for j := 0; j < 5; j++ {
			d[j] = xor(api, c[(j+4)%5], rotateLeft(c[(j+1)%5], 1))
			da[j] = xor(api, a[((j+4)%5)*5], rotateLeft(a[((j+1)%5)*5], 1))
		}

		for j := 0; j < 25; j++ {
			tmp := xor(api, da[j/5], a[j])
			a[j] = xor(api, tmp, d[j/5])
		}

		b[0] = a[0]
		b[8] = rotateLeft(a[1], 36)
		b[11] = rotateLeft(a[2], 3)
		b[19] = rotateLeft(a[3], 41)
		b[22] = rotateLeft(a[4], 18)
		b[2] = rotateLeft(a[5], 1)
		b[5] = rotateLeft(a[6], 44)
		b[13] = rotateLeft(a[7], 10)
		b[16] = rotateLeft(a[8], 45)
		b[24] = rotateLeft(a[9], 2)
		b[4] = rotateLeft(a[10], 62)
		b[7] = rotateLeft(a[11], 6)
		b[10] = rotateLeft(a[12], 43)
		b[18] = rotateLeft(a[13], 15)
		b[21] = rotateLeft(a[14], 61)
		b[1] = rotateLeft(a[15], 28)
		b[9] = rotateLeft(a[16], 55)
		b[12] = rotateLeft(a[17], 25)
		b[15] = rotateLeft(a[18], 21)
		b[23] = rotateLeft(a[19], 56)
		b[3] = rotateLeft(a[20], 27)
		b[6] = rotateLeft(a[21], 20)
		b[14] = rotateLeft(a[22], 39)
		b[17] = rotateLeft(a[23], 8)
		b[20] = rotateLeft(a[24], 14)

		a[0] = xor(api, b[0], and(api, not(api, b[5]), b[10]))
		a[1] = xor(api, b[1], and(api, not(api, b[6]), b[11]))
		a[2] = xor(api, b[2], and(api, not(api, b[7]), b[12]))
		a[3] = xor(api, b[3], and(api, not(api, b[8]), b[13]))
		a[4] = xor(api, b[4], and(api, not(api, b[9]), b[14]))
		a[5] = xor(api, b[5], and(api, not(api, b[10]), b[15]))
		a[6] = xor(api, b[6], and(api, not(api, b[11]), b[16]))
		a[7] = xor(api, b[7], and(api, not(api, b[12]), b[17]))
		a[8] = xor(api, b[8], and(api, not(api, b[13]), b[18]))
		a[9] = xor(api, b[9], and(api, not(api, b[14]), b[19]))
		a[10] = xor(api, b[10], and(api, not(api, b[15]), b[20]))
		a[11] = xor(api, b[11], and(api, not(api, b[16]), b[21]))
		a[12] = xor(api, b[12], and(api, not(api, b[17]), b[22]))
		a[13] = xor(api, b[13], and(api, not(api, b[18]), b[23]))
		a[14] = xor(api, b[14], and(api, not(api, b[19]), b[24]))
		a[15] = xor(api, b[15], and(api, not(api, b[20]), b[0]))
		a[16] = xor(api, b[16], and(api, not(api, b[21]), b[1]))
		a[17] = xor(api, b[17], and(api, not(api, b[22]), b[2]))
		a[18] = xor(api, b[18], and(api, not(api, b[23]), b[3]))
		a[19] = xor(api, b[19], and(api, not(api, b[24]), b[4]))
		a[20] = xor(api, b[20], and(api, not(api, b[0]), b[5]))
		a[21] = xor(api, b[21], and(api, not(api, b[1]), b[6]))
		a[22] = xor(api, b[22], and(api, not(api, b[2]), b[7]))
		a[23] = xor(api, b[23], and(api, not(api, b[3]), b[8]))
		a[24] = xor(api, b[24], and(api, not(api, b[4]), b[9]))

		for j := 0; j < len(a[0]); j++ {
			if rcs[i][j] == 1 {
				a[0][j] = api.Add(1, a[0][j])
			}
		}
	}

	return a
}

func checkTransition(api frontend.API, inState, outState []frontend.Variable) {
	input := make([][]frontend.Variable, 25)
	for lane := 0; lane < 25; lane++ {
		input[lane] = make([]frontend.Variable, 64)
		for bit := 0; bit < 64; bit++ {
			index := lane*64 + bit
			assertIsBoolean(api, inState[index])
			assertIsBoolean(api, outState[index])
			input[lane][bit] = inState[index]
		}
	}
	computed := keccakF(api, input)
	for lane := 0; lane < 25; lane++ {
		for bit := 0; bit < 64; bit++ {
			api.AssertIsEqual(computed[lane][bit], outState[lane*64+bit])
		}
	}
}

func (t *keccakTransitionCircuit) Define(api frontend.API) error {
	check := eccbuilder.MemorizedVoidFunc(checkTransition)
	for i := 0; i < NPermutations; i++ {
		check(api, t.In[i][:], t.Out[i][:])
	}
	return nil
}

func laneBits(laneHex string) ([64]int, error) {
	var bits [64]int
	cleaned := strings.TrimPrefix(strings.ToLower(laneHex), "0x")
	value, err := strconv.ParseUint(cleaned, 16, 64)
	if err != nil {
		return bits, err
	}
	for bit := 0; bit < 64; bit++ {
		bits[bit] = int((value >> bit) & 1)
	}
	return bits, nil
}

func loadBatch(path string) (*batchFileJSON, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var batch batchFileJSON
	if err := json.Unmarshal(raw, &batch); err != nil {
		return nil, err
	}
	if batch.Schema != "paxiom.expander_keccak_batch.v1" {
		return nil, fmt.Errorf("unexpected batch schema %q", batch.Schema)
	}
	if len(batch.Permutations) < PermutationOffset+NPermutations {
		return nil, fmt.Errorf("expected at least %d permutations for chunk, got len=%d", PermutationOffset+NPermutations, len(batch.Permutations))
	}
	return &batch, nil
}

func assignBatch(circuit *keccakTransitionCircuit, batch *batchFileJSON) error {
	for i, permutation := range batch.Permutations[PermutationOffset:PermutationOffset+NPermutations] {
		if len(permutation.InputState) != 25 || len(permutation.OutputState) != 25 {
			return fmt.Errorf("permutation %d must have 25-lane input/output states", i)
		}
		for lane := 0; lane < 25; lane++ {
			inputBits, err := laneBits(permutation.InputState[lane])
			if err != nil {
				return fmt.Errorf("permutation %d input lane %d: %w", i, lane, err)
			}
			outputBits, err := laneBits(permutation.OutputState[lane])
			if err != nil {
				return fmt.Errorf("permutation %d output lane %d: %w", i, lane, err)
			}
			x := lane % 5
			y := lane / 5
			expanderLane := 5*x + y
			for bit := 0; bit < 64; bit++ {
				index := expanderLane*64 + bit
				circuit.In[i][index] = inputBits[bit]
				circuit.Out[i][index] = outputBits[bit]
			}
		}
	}
	return nil
}

func main() {
	batch, err := loadBatch(batchPath)
	if err != nil {
		panic(err)
	}

	var circuit keccakTransitionCircuit
	cr, err := ecgo.Compile(gf2.ScalarField, &circuit)
	if err != nil {
		panic(err)
	}
	layered := cr.GetLayeredCircuit()
	if err := os.WriteFile("circuit.txt", layered.Serialize(), 0o644); err != nil {
		panic(err)
	}

	assignments := make([]frontend.Circuit, 8)
	for i := 0; i < len(assignments); i++ {
		assigned := &keccakTransitionCircuit{}
		if err := assignBatch(assigned, batch); err != nil {
			panic(err)
		}
		assignments[i] = assigned
	}
	witness, err := cr.GetInputSolver().SolveInputs(assignments)
	if err != nil {
		panic(err)
	}
	for _, ok := range test.CheckCircuitMultiWitness(layered, witness) {
		if !ok {
			panic("generated Paxiom Keccak-f witness does not satisfy the Expander circuit")
		}
	}
	if err := os.WriteFile("witness.txt", witness.Serialize(), 0o644); err != nil {
		panic(err)
	}

	receipt := map[string]any{
		"schema": "paxiom.expander_keccak_adapter_receipt.v1",
		"batch_commitment": batch.Commitment,
		"witness_commitment": batch.WitnessCommitment,
		"batch_permutation_count": batch.PermutationCount,
		"permutation_offset": PermutationOffset,
		"permutation_count": NPermutations,
		"circuit_file": "circuit.txt",
		"witness_file": "witness.txt",
	}
	receiptJSON, _ := json.MarshalIndent(receipt, "", "  ")
	_ = os.WriteFile("adapter-receipt.json", append(receiptJSON, '\\n'), 0o644)
	fmt.Printf("adapter generated circuit/witness for %d Paxiom Keccak-f transitions at offset %d\\n", NPermutations, PermutationOffset)
}
`;
}

function main() {
  const batch = resolve(repoRoot, arg("batch", join(repoRoot, ".paxiom-runtime", "expander-keccak-batch.json")));
  const outDir = resolve(repoRoot, arg("out-dir", join(repoRoot, ".paxiom-runtime", "expander-keccak-adapter")));
  const compilerRoot = resolve(repoRoot, ".paxiom-runtime", "upstream", "ExpanderCompilerCollection");
  const parsed = JSON.parse(readFileSync(batch, "utf8"));
  const offset = Number(arg("offset", "0"));
  const requestedCount = arg("count", "");

  assert(parsed.schema === "paxiom.expander_keccak_batch.v1", "Expected paxiom.expander_keccak_batch.v1");
  assert(Number.isInteger(parsed.permutation_count) && parsed.permutation_count > 0, "Batch has no permutations");
  assert(Array.isArray(parsed.permutations), "Batch is missing permutations");
  assert(parsed.permutation_count === parsed.permutations.length, "Permutation count does not match permutation list");
  assert(parsed.permutations.every(p => p.input_state?.length === 25 && p.output_state?.length === 25), "Every permutation needs 25-lane states");
  assert(Number.isInteger(offset) && offset >= 0, "Offset must be a non-negative integer");
  const count = requestedCount === "" ? parsed.permutation_count - offset : Number(requestedCount);
  assert(Number.isInteger(count) && count > 0, "Count must be a positive integer");
  assert(offset + count <= parsed.permutations.length, "Chunk exceeds permutation list");

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "go.mod"), `module paxiom-expander-keccak-adapter

go 1.21.6

require (
	github.com/PolyhedraZK/ExpanderCompilerCollection v0.0.0
	github.com/consensys/gnark v0.10.0
	github.com/consensys/gnark-crypto v0.13.0
)

replace github.com/PolyhedraZK/ExpanderCompilerCollection v0.0.0 => ${compilerRoot}
`);
  writeFileSync(join(outDir, "main.go"), adapterSource({
    permutationCount: count,
    permutationOffset: offset,
    batchFile: batch
  }));

  const receipt = {
    schema: "paxiom.expander_keccak_adapter_plan.v1",
    batch,
    out_dir: outDir,
    batch_commitment: parsed.commitment,
    witness_commitment: parsed.witness_commitment,
    batch_permutation_count: parsed.permutation_count,
    permutation_offset: offset,
    permutation_count: count,
    generated_files: [
      join(outDir, "go.mod"),
      join(outDir, "main.go")
    ]
  };
  writeFileSync(join(outDir, "adapter-plan.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
}

if (require.main === module) {
  main();
}
