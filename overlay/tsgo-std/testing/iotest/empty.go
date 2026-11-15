// go-in-types overlay (tsgo config): emptied. logger.go is the only user of
// log (and through it os) in testing/iotest, which testing/fstest (vfstest)
// imports; the harness never calls the loggers.
package iotest
