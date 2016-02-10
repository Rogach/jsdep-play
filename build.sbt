name := """jsdep-play"""

lazy val root = (project in file(".")).enablePlugins(PlayScala, SbtWeb)

scalaVersion := "2.11.7"

libraryDependencies ++= Seq(
  "org.webjars" % "angularjs" % "1.4.7",
  "org.webjars" % "requirejs" % "2.1.20"
)

routesGenerator := InjectedRoutesGenerator

pipelineStages := Seq(rjs, digest, gzip)

RjsKeys.webJarCdns := Map.empty

RjsKeys.generateSourceMaps := false

RjsKeys.baseUrl := "."
